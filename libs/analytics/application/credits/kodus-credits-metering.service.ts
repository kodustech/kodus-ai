/**
 * Metering sweep for "Kodus as the provider".
 *
 * Every LLM call routed by the `kodus` provider leaves a usage span in
 * `observability_telemetry` (`gen_ai.response.model` = `kodus:<catalog id>`,
 * `attributes.tu` with the token split). This service turns those spans into
 * money: it journals each one as a charge at the catalog's list price
 * (`kodus_credit_charges`, unique per span) and debits the batch from the
 * org's prepaid balance in the billing service, idempotently (`usageKey` =
 * `span:<id>`).
 *
 * Why per SPAN, not per review: a review runs for minutes and its spans land
 * as they finish, so billing "per correlationId once" would either wait for a
 * run to end (which the sweep cannot know) or miss the tail. Per span, every
 * record is final the moment it exists; completeness is then a matter of
 * re-reading an overlapping window, and the unique span index makes the
 * overlap free.
 *
 * Why a sweep, not an inline debit at the end of the review: conversation,
 * kody-rules generation and summaries also spend on the provider outside the
 * review pipeline; one path bills them all the same way, and a billing outage
 * costs a retry on the next tick, never a lost charge.
 */
import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { isByokConfig } from '@libs/llm/byok-config';
import { isPlatformFundedProvider } from '@libs/llm/platform-funded-provider';
import { KODUS_CATALOG_PRICES_AS_OF } from '@libs/llm/providers/kodus/catalog';
import { kodusModelUsageCostUsd } from '@libs/llm/providers/kodus/usage-cost';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
    DebitCreditsEntry,
} from '@libs/ee/license/interfaces/license.interface';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import type { KodusCreditChargeModel } from '@libs/analytics/infrastructure/adapters/repositories/schemas/kodusCreditCharge.model';
import {
    IKodusCreditsLedgerRepository,
    KODUS_CREDITS_LEDGER_REPOSITORY_TOKEN,
    KodusCreditChargeEntry,
} from '@libs/analytics/domain/credits/contracts/kodus-credits-ledger.repository.contract';

/** A span is considered settled this long after its timestamp (flush lag). */
export const SWEEP_SETTLE_MS = 2 * 60 * 1000;
/** Re-read this far behind the cursor so late-flushed spans are still caught. */
export const SWEEP_OVERLAP_MS = 15 * 60 * 1000;
/** First sweep for an org looks back this far (older usage is never billed). */
export const SWEEP_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Max spans journaled per org per tick, and max entries per debit call. */
export const SWEEP_SPAN_CAP = 2000;
export const DEBIT_BATCH_SIZE = 500;

/**
 * The usage span stores the model under the literal key `gen_ai.response.model`
 * INSIDE `attributes` — a key that contains dots. Mongo dot-notation cannot
 * address such a key (`attributes.gen_ai.response.model` walks nested docs
 * and matches nothing), so the filter reads it with `$getField` under `$expr`.
 * Verified live on 2026-09-09: the dot path matched 0 of 10 Kodus spans.
 */
export interface SweepSummary {
    organizationId: string;
    spansSeen: number;
    journaled: number;
    debited: number;
    debitedUsd: number;
    unpriced: number;
    failed: number;
    balanceUsd?: number;
}

/** `before` arrives as the validated ISO string from the query DTO (or a
 *  Date from internal callers); the controller stays a transport adapter. */
function normalizeBefore(before: Date | string | undefined): Date | undefined {
    if (before === undefined) return undefined;
    const d = before instanceof Date ? before : new Date(before);
    return Number.isNaN(d.getTime()) ? undefined : d;
}

/** DI token for the metering service (consumers inject the token, not the class). */
export const KODUS_CREDITS_METERING_SERVICE_TOKEN = Symbol.for(
    'KodusCreditsMeteringService',
);

@Injectable()
export class KodusCreditsMeteringService {
    private readonly logger = createLogger(KodusCreditsMeteringService.name);

    constructor(
        @Inject(KODUS_CREDITS_LEDGER_REPOSITORY_TOKEN)
        private readonly ledger: IKodusCreditsLedgerRepository,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
    ) {}

    /** Orgs whose stored BYOK config carries a `kodus` credential. */
    async listOrganizationsWithKodusCredential(): Promise<string[]> {
        const params = await this.organizationParametersService
            .find({ configKey: OrganizationParametersKey.BYOK_CONFIG })
            .catch(() => []);
        const out: string[] = [];
        for (const parameter of params ?? []) {
            const organizationId = parameter.organization?.uuid;
            const config = parameter.configValue;
            if (!organizationId || !isByokConfig(config)) continue;
            const hasKodus = (config.credentials ?? []).some(
                (c) => c && isPlatformFundedProvider(c.provider),
            );
            if (hasKodus) out.push(organizationId);
        }
        return out;
    }

    /** One tick for one org: journal new spans, then debit what is pending. */
    async sweepOrganization(
        organizationId: string,
        now: Date = new Date(),
    ): Promise<SweepSummary> {
        const summary: SweepSummary = {
            organizationId,
            spansSeen: 0,
            journaled: 0,
            debited: 0,
            debitedUsd: 0,
            unpriced: 0,
            failed: 0,
        };

        const upper = new Date(now.getTime() - SWEEP_SETTLE_MS);
        const stoppedAt = await this.ledger.getSweepCursor(organizationId);
        const cursor = stoppedAt
            ? new Date(stoppedAt.getTime() - SWEEP_OVERLAP_MS)
            : new Date(now.getTime() - SWEEP_INITIAL_LOOKBACK_MS);

        if (cursor >= upper) {
            await this.debitPending(organizationId, summary);
            return summary;
        }

        const spans = await this.ledger.findKodusRoutedSpans({
            organizationId,
            after: cursor,
            upTo: upper,
            limit: SWEEP_SPAN_CAP,
        });

        summary.spansSeen = spans.length;
        if (spans.length > 0) {
            this.logger.log({
                message: 'Kodus credits sweep: spans found',
                context: KodusCreditsMeteringService.name,
                metadata: { organizationId, spans: spans.length, cursor, upper },
            });
        }
        let maxTimestamp = cursor;

        // One journal write per org per tick instead of a round-trip per
        // span: it is idempotent on spanId, so a re-read of the overlap
        // window inserts nothing and costs one call.
        const ops: Array<{
            unpriced: boolean;
            entry: KodusCreditChargeEntry;
        }> = [];
        for (const span of spans) {
            const tu = span.attributes?.tu;
            const ts = span.timestamp ? new Date(span.timestamp) : null;
            if (!tu || !ts) continue;
            if (ts > maxTimestamp) maxTimestamp = ts;

            const model = String(tu.model ?? '');
            const tokens = {
                input: Number(tu.input ?? 0),
                output: Number(tu.output ?? 0),
                reasoning: Number(tu.reasoning ?? 0),
                cacheRead: Number(tu.cacheRead ?? 0),
                cacheWrite: Number(tu.cacheWrite ?? 0),
            };
            const amountUsd = kodusModelUsageCostUsd(model, tokens);
            const spanId = String(span._id);
            ops.push({
                unpriced: amountUsd === null,
                entry: {
                    spanId,
                    organizationId,
                    teamId: span.attributes?.teamId ?? undefined,
                    correlationId: span.correlationId,
                    prNumber:
                        typeof span.attributes?.prNumber === 'number'
                            ? span.attributes.prNumber
                            : undefined,
                    modelId: model,
                    area: tu.area,
                    route: tu.route,
                    tokens,
                    amountUsd: amountUsd ?? 0,
                    pricingAsOf: KODUS_CATALOG_PRICES_AS_OF,
                    status: amountUsd === null ? 'unpriced' : 'pending',
                    spanAt: ts,
                },
            });
        }

        if (ops.length > 0) {
            try {
                const res = await this.ledger.journalCharges(
                    ops.map((o) => o.entry),
                );
                // `upsertedIds` is keyed by the op index, so the unpriced
                // count covers only rows this tick actually inserted.
                const inserted = new Set(
                    Object.keys(res.upsertedIds ?? {}).map(Number),
                );
                summary.journaled += res.upsertedCount ?? inserted.size;
                for (const idx of inserted) {
                    if (ops[idx]?.unpriced) summary.unpriced += 1;
                }
            } catch (error) {
                // An unordered bulk write applies what it can; count the rest.
                const writeErrors = (
                    error as { writeErrors?: unknown[]; result?: { upsertedCount?: number } }
                )?.writeErrors;
                const applied =
                    (error as { result?: { upsertedCount?: number } })?.result
                        ?.upsertedCount ?? 0;
                summary.journaled += applied;
                summary.failed += Array.isArray(writeErrors)
                    ? writeErrors.length
                    : ops.length - applied;
                this.logger.error({
                    message: 'Failed to journal Kodus credit charges',
                    context: KodusCreditsMeteringService.name,
                    error: error instanceof Error ? error : undefined,
                    metadata: {
                        organizationId,
                        spans: ops.length,
                        failed: summary.failed,
                    },
                });
            }
        }

        if (summary.unpriced > 0) {
            this.logger.error({
                message:
                    'Kodus-routed usage on a model missing from the price list — journaled as unpriced, NOT debited',
                context: KodusCreditsMeteringService.name,
                metadata: { organizationId, unpriced: summary.unpriced },
            });
        }

        // Advance the cursor only when the window was fully read; a capped read
        // stops at the last span seen so the next tick resumes from there.
        const nextCursor =
            spans.length >= SWEEP_SPAN_CAP ? maxTimestamp : upper;
        await this.ledger.saveSweepCursor(organizationId, nextCursor, now);

        await this.debitPending(organizationId, summary);
        return summary;
    }

    /** Debit every `pending` charge, in batches, grouped by team (the license
     *  is per org+team). A batch that fails stays pending for the next tick. */
    private async debitPending(
        organizationId: string,
        summary: SweepSummary,
    ): Promise<void> {
        const pending = await this.ledger.findPendingCharges(
            organizationId,
            DEBIT_BATCH_SIZE * 4,
        );
        if (pending.length === 0) return;

        const byTeam = new Map<string, typeof pending>();
        for (const charge of pending) {
            const key = charge.teamId ?? '';
            const list = byTeam.get(key) ?? [];
            list.push(charge);
            byTeam.set(key, list);
        }

        for (const [teamKey, charges] of byTeam) {
            for (let i = 0; i < charges.length; i += DEBIT_BATCH_SIZE) {
                const batch = charges.slice(i, i + DEBIT_BATCH_SIZE);
                const entries: DebitCreditsEntry[] = batch.map((c) => ({
                    usageKey: `span:${c.spanId}`,
                    amountUsd: c.amountUsd,
                    metadata: {
                        model: c.modelId,
                        correlationId: c.correlationId,
                        prNumber: c.prNumber,
                        area: c.area,
                        tokens: c.tokens,
                        spanAt: c.spanAt,
                    },
                }));
                try {
                    const result = await this.licenseService.debitCredits(
                        {
                            organizationId,
                            teamId: teamKey || undefined,
                        } as any,
                        entries,
                    );
                    const debitedAt = new Date();
                    await this.ledger.markChargesDebited(
                        batch.map((c) => c.spanId),
                        debitedAt,
                    );
                    summary.debited += batch.length;
                    summary.debitedUsd += batch.reduce(
                        (s, c) => s + (c.amountUsd ?? 0),
                        0,
                    );
                    summary.balanceUsd = result?.balanceUsd;
                } catch (error) {
                    summary.failed += batch.length;
                    const message =
                        error instanceof Error ? error.message : String(error);
                    await this.ledger.recordChargeError(
                        batch.map((c) => c.spanId),
                        message,
                    );
                    this.logger.error({
                        message:
                            'Kodus credit debit failed — charges stay pending for the next sweep',
                        context: KodusCreditsMeteringService.name,
                        error: error instanceof Error ? error : undefined,
                        metadata: {
                            organizationId,
                            teamId: teamKey || undefined,
                            entries: batch.length,
                        },
                    });
                }
            }
        }
    }

    /** Journal read for the UI: recent charges, newest first. */
    async listCharges(
        organizationId: string,
        options: { limit?: number; before?: Date | string; prNumber?: number } = {},
    ): Promise<KodusCreditChargeModel[]> {
        return this.ledger.listCharges(organizationId, {
            limit: Math.min(Math.max(options.limit ?? 100, 1), 500),
            before: normalizeBefore(options.before),
            prNumber:
                typeof options.prNumber === 'number'
                    ? options.prNumber
                    : undefined,
        });
    }
}
