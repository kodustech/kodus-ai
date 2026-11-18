import { ConflictException, ForbiddenException, HttpException, HttpStatus, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { isTerminal } from '@libs/runtime/run';

import { startOfUtcDay, withOrgBudget, type RuntimeLlmBudgetLimits } from '../domain/budget';
import {
    LlmBudgetBusyError,
    type RunProjectionReader,
    type RuntimeApiConfig,
    type RuntimeLlmUsageStore,
    type RuntimeRunProjection,
    type RuntimeSettingsStore,
} from '../domain/ports';
import type { RunTokenClaims } from '../domain/run-token';

// What every model call a Run token pays for shares: the Run must be the
// token's own, of its org and attempt, and still running; the org's own daily
// budget can only lower the gateway's; and the tokens are reserved under the
// Run's budget scopes before the call, in one step, so parallel calls of one
// org cannot all pass on the same total.

/** What a Run whose token does not match is told: one message for every mismatch, or one per field. */
export interface LiveRunCheck {
    mismatch?: string;
    /** Token fields the Run projection must also match (checked after the attempt). */
    sameAs?: ReadonlyArray<'repositoryId' | 'prNumber' | 'teamId'>;
}

/**
 * The Run a Run token may spend for: the token's Run, read under the token's
 * org (another org's Run answers 404), at the token's attempt, not finished.
 */
export async function liveRunFor(runs: RunProjectionReader, claims: RunTokenClaims, runId: string, check: LiveRunCheck = {}): Promise<RuntimeRunProjection> {
    if (runId !== claims.runId) throw new ForbiddenException(check.mismatch ?? 'The run token is for another Run');
    const run = await runs.get(runId, { organizationId: claims.organizationId });
    if (!run || run.organizationId !== claims.organizationId) throw new NotFoundException('Run not found');
    if (run.attempt !== claims.attempt) throw new ForbiddenException(check.mismatch ?? 'The run token is for another attempt');
    for (const field of check.sameAs ?? []) {
        if (run[field] !== claims[field]) throw new ForbiddenException(check.mismatch ?? `The run token is for another ${field}`);
    }
    if (isTerminal(run.state)) throw new ConflictException('The Run has finished');
    return run;
}

/** The gateway's budget limits, lowered by the org's own daily budget (Settings) when it has one. */
export async function orgLlmBudget(
    config: Pick<RuntimeApiConfig, 'llmBudget'>,
    settings: Pick<RuntimeSettingsStore, 'getOrganization'> | undefined,
    organizationId: string,
): Promise<RuntimeLlmBudgetLimits> {
    const org = await settings?.getOrganization(organizationId);
    return withOrgBudget(config.llmBudget, org?.tokenBudgetPerDay);
}

/** The budget scopes one call is counted under: its Run, PR, org day and task. */
export interface LlmCallScope {
    runId: string;
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    task: string;
}

export type ReservationRequest = Parameters<RuntimeLlmUsageStore['reserve']>[0];

/** The reserve request of one call made at `now`: counted on `now`'s UTC day. */
export const reservationFor = (scope: LlmCallScope, now: Date, decide: ReservationRequest['decide']): ReservationRequest => ({
    usage: { runId: scope.runId, organizationId: scope.organizationId, repositoryId: scope.repositoryId, prNumber: scope.prNumber, task: scope.task, at: now },
    orgDayStart: startOfUtcDay(now),
    decide,
});

export interface LlmReservation {
    reservationId: string;
    tokens: number;
}

/**
 * What a reservation becomes when the call made under it throws:
 * - `release`: the call spent nothing; the tokens go back to every scope.
 * - `count_reserved`: what the call spent is unknown; the whole reservation is settled as spent on the Run and the org's
 *   day, never on the pull request's lifetime counter (a provider outage must not lock a PR out for good, V-05); a
 *   failure to settle leaves it counted everywhere.
 * - `leave`: the call owns the reservation and releases or settles it itself.
 */
export type ReservationFailure = 'release' | 'count_reserved' | 'leave';

export interface WithReservationOptions {
    /** Fixed, or chosen from the error: a call can tell "never sent" from "may have spent". */
    onFailure: ReservationFailure | ((error: unknown) => ReservationFailure);
    /** The store's lock was busy: answer 503 llm_budget_busy (retryable) instead of the raw error. */
    busyAsUnavailable?: boolean;
    /** The model a `count_reserved` settle names. */
    model?: string;
}

export type ReservedCall<T> = { reserved: false } | { reserved: true; reservation: LlmReservation; value: T };

/**
 * Reserves what `request.decide` grants and runs `call` under it. When the
 * budget refuses, nothing is reserved, `call` never runs and the result is
 * `{ reserved: false }`: the caller answers its own refusal. When `call`
 * throws, `onFailure` decides the reservation and the error is rethrown. On
 * success the caller settles the reservation with what the call measured.
 */
export async function withReservation<T>(
    usage: Pick<RuntimeLlmUsageStore, 'reserve' | 'settle' | 'cancel'>,
    request: ReservationRequest,
    call: (reservation: LlmReservation) => Promise<T>,
    options: WithReservationOptions,
): Promise<ReservedCall<T>> {
    const reservation = await usage.reserve(request).catch((e: unknown) => {
        if (options.busyAsUnavailable && e instanceof LlmBudgetBusyError) throw new ServiceUnavailableException({ code: 'llm_budget_busy', message: e.message });
        throw e;
    });
    if (!reservation) return { reserved: false };
    try {
        return { reserved: true, reservation, value: await call(reservation) };
    } catch (e) {
        const onFailure = typeof options.onFailure === 'function' ? options.onFailure(e) : options.onFailure;
        if (onFailure === 'release') await usage.cancel(reservation.reservationId);
        else if (onFailure === 'count_reserved') {
            // A failed settle leaves the whole reservation counted (ReservationFailure); the call's own error is rethrown below.
            await usage
                .settle(reservation.reservationId, { inputTokens: reservation.tokens, outputTokens: 0, failedAttempt: true, ...(options.model ? { model: options.model } : {}) })
                .catch(() => undefined);
        }
        throw e;
    }
}

/** The scope that refused a call, and how much of it was spent. */
export interface BudgetRefusal {
    exhausted: string;
    spent: number;
    limit: number;
}

/** The 429 a refused call answers, with the scope that refused it. */
export const llmBudgetExceeded = (refused: BudgetRefusal) =>
    new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, code: 'llm_budget_exceeded', scope: refused.exhausted, spent: refused.spent, limit: refused.limit },
        HttpStatus.TOO_MANY_REQUESTS,
    );
