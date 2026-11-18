import { randomUUID } from 'node:crypto';

import { createLogger } from '@libs/core/log/logger';

import {
    LlmBudgetBusyError,
    type RuntimeLlmSettledUsage,
    type RuntimeLlmSpendSnapshot,
    type RuntimeLlmUsageRecord,
    type RuntimeLlmUsageStore,
} from '../domain/ports';
import type { Sql, TransactionalSql } from './typeorm-sql';

/** Token counters of the three budget scopes, one row per scope key. */
export const RUNTIME_LLM_BUDGET_TABLE = 'runtime_llm_budget';
/** Calls in flight: what each reserved and on which counters, until it settles. */
export const RUNTIME_LLM_RESERVATIONS_TABLE = 'runtime_llm_reservations';

/** The key of a model's split in by_model; "none" for a call that reported no model. */
const NO_MODEL_KEY = 'none';
export const modelKey = (model: string | undefined) => (model ? `m_${encodeURIComponent(model).replace(/\./g, '%2E')}` : NO_MODEL_KEY);

const DAY_MS = 24 * 60 * 60 * 1000;
/** A reservation that never settles (a crash mid-call) is dropped after this; its tokens stay counted. */
const RESERVATION_TTL_MS = DAY_MS;
/** The per-day counter outlives its day so a call reserved at 23:59 still settles onto it. */
const ORG_DAY_TTL_MS = 2 * DAY_MS;
/** How long a call waits for another call of the same org to finish its reservation, before it is refused as busy. */
const DEFAULT_LOCK_WAIT_MS = 5_000;
/** lock_not_available: lock_timeout passed. */
const LOCK_NOT_AVAILABLE = '55P03';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const part = (s: string | number) => encodeURIComponent(String(s));
export const runCounterKey = (runId: string) => `run/${part(runId)}`;
const PULL_REQUEST_COUNTER_PREFIX = 'pr/';
export const pullRequestCounterKey = (u: Pick<RuntimeLlmUsageRecord, 'organizationId' | 'repositoryId' | 'prNumber'>) =>
    `${PULL_REQUEST_COUNTER_PREFIX}${part(u.organizationId)}/${part(u.repositoryId)}/${part(u.prNumber)}`;
export const orgDayCounterKey = (organizationId: string, dayStart: Date) => `org-day/${part(organizationId)}/${dayStart.toISOString().slice(0, 10)}`;

const whole = (v: unknown) => Number(v ?? 0);
const nonNegative = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * The gateway's budget (S-47) in the product Postgres. The consumption record
 * of each call is its usage span in `observability_telemetry` (LLM.run writes
 * it, with the Run's ids); this store keeps only what the budget needs: a
 * counter per scope and the reservations still in flight.
 *
 * Check and reserve is one transaction under a lock per org (every scope of a
 * call belongs to one org): the counters are read, `decide` is asked, and the
 * tokens are added and the reservation inserted before the lock is let go. So
 * concurrent calls of one org decide one after the other, on the totals the
 * one before left, and never pass a limit together. Settling and cancelling
 * move the counters by an atomic increment, without the lock; a call that
 * waits past the lock wait is refused (LlmBudgetBusyError) with nothing taken.
 */
export class TypeOrmRuntimeLlmBudgetStore implements RuntimeLlmUsageStore {
    private readonly logger = createLogger(TypeOrmRuntimeLlmBudgetStore.name);

    constructor(
        private readonly sql: TransactionalSql,
        private readonly lockWaitMs = DEFAULT_LOCK_WAIT_MS,
    ) {}

    async reserve(input: Parameters<RuntimeLlmUsageStore['reserve']>[0]) {
        const u = input.usage;
        const scope = {
            run: runCounterKey(u.runId),
            pullRequest: pullRequestCounterKey(u),
            orgToday: orgDayCounterKey(u.organizationId, input.orgDayStart),
        };
        const keys = [scope.orgToday, scope.pullRequest, scope.run];
        const dayExpiry = new Date(input.orgDayStart.getTime() + ORG_DAY_TTL_MS);
        try {
            return await this.sql.transaction(async (tx) => {
                await tx.query(`SET LOCAL lock_timeout = ${Math.max(1, Math.floor(this.lockWaitMs))}`);
                await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`kody-runtime/llm-budget/${u.organizationId}`]);
                const seen = new Map(
                    (await tx.query(`SELECT key, tokens FROM ${RUNTIME_LLM_BUDGET_TABLE} WHERE key = ANY($1::text[])`, [keys])).rows.map((r) => [String(r.key), whole(r.tokens)]),
                );
                const spend: RuntimeLlmSpendSnapshot = {
                    run: seen.get(scope.run) ?? 0,
                    pullRequest: seen.get(scope.pullRequest) ?? 0,
                    orgToday: seen.get(scope.orgToday) ?? 0,
                };
                const tokens = input.decide(spend);
                if (tokens === null) return null;
                if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error(`a reservation must be a whole number of tokens, got ${tokens}`);
                await tx.query(
                    `INSERT INTO ${RUNTIME_LLM_BUDGET_TABLE} AS b (key, tokens, expires_at)
                     VALUES ($1, $4, $5), ($2, $4, NULL), ($3, $4, NULL)
                     ON CONFLICT (key) DO UPDATE SET tokens = b.tokens + EXCLUDED.tokens`,
                    [scope.orgToday, scope.pullRequest, scope.run, tokens, dayExpiry],
                );
                const reservationId = randomUUID();
                await tx.query(
                    `INSERT INTO ${RUNTIME_LLM_RESERVATIONS_TABLE} (reservation_id, run_id, organization_id, repository_id, pr_number, task, at, counters, tokens, expires_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10)`,
                    [reservationId, u.runId, u.organizationId, u.repositoryId, u.prNumber, u.task, u.at, keys, tokens, new Date(u.at.getTime() + RESERVATION_TTL_MS)],
                );
                return { reservationId, tokens };
            });
        } catch (e) {
            if ((e as { code?: string })?.code !== LOCK_NOT_AVAILABLE) throw e;
            throw new LlmBudgetBusyError();
        }
    }

    async settle(reservationId: string, actual: RuntimeLlmSettledUsage): Promise<void> {
        // A failed attempt gives the pull request's lifetime counter its share back; the Run and the org day keep it.
        const r = await this.release(reservationId, 'settle', (reserved, key) =>
            actual.failedAttempt && key.startsWith(PULL_REQUEST_COUNTER_PREFIX) ? -reserved : actual.inputTokens + actual.outputTokens - reserved,
        );
        if (!r) return;
        // The split is for the Run's cost only; the budget decided on the counter above.
        await this.sql.query(
            `UPDATE ${RUNTIME_LLM_BUDGET_TABLE} SET by_model = by_model || jsonb_build_object($2::text, jsonb_build_object(
                 'input', COALESCE((by_model->$2->>'input')::bigint, 0) + $3,
                 'output', COALESCE((by_model->$2->>'output')::bigint, 0) + $4,
                 'cacheRead', COALESCE((by_model->$2->>'cacheRead')::bigint, 0) + $5,
                 'cacheWrite', COALESCE((by_model->$2->>'cacheWrite')::bigint, 0) + $6))
             WHERE key = $1`,
            [
                runCounterKey(r.runId),
                modelKey(actual.model),
                nonNegative(actual.inputTokens),
                nonNegative(actual.outputTokens),
                nonNegative(actual.cacheReadTokens),
                nonNegative(actual.cacheWriteTokens),
            ],
        );
    }

    async cancel(reservationId: string): Promise<void> {
        await this.release(reservationId, 'cancel', (reserved) => -reserved);
    }

    async totalForRun(runId: string): Promise<number> {
        const row = (await this.sql.query(`SELECT tokens FROM ${RUNTIME_LLM_BUDGET_TABLE} WHERE key = $1`, [runCounterKey(runId)])).rows[0];
        return row ? whole(row.tokens) : 0;
    }

    /** Takes the reservation once (a second settle finds nothing), then moves its counters by the difference. */
    private async release(reservationId: string, op: 'settle' | 'cancel', delta: (reserved: number, key: string) => number): Promise<{ runId: string } | null> {
        // Reservation ids are the UUIDs reserve() hands out; anything else names no reservation.
        const r = UUID.test(reservationId)
            ? (await this.sql.query(`DELETE FROM ${RUNTIME_LLM_RESERVATIONS_TABLE} WHERE reservation_id = $1 RETURNING run_id, counters, tokens`, [reservationId])).rows[0]
            : undefined;
        if (!r) {
            this.logger.warn({
                message: 'Runtime LLM reservation not found; it settled already or expired',
                context: TypeOrmRuntimeLlmBudgetStore.name,
                metadata: { reservationId, op },
            });
            return null;
        }
        const byDelta = new Map<number, string[]>();
        for (const key of r.counters as string[]) {
            const d = delta(whole(r.tokens), key);
            byDelta.set(d, [...(byDelta.get(d) ?? []), key]);
        }
        for (const [d, keys] of byDelta) await this.add(this.sql, keys, d);
        return { runId: String(r.run_id) };
    }

    private async add(sql: Sql, keys: string[], delta: number) {
        if (!keys.length || delta === 0) return;
        await sql.query(`UPDATE ${RUNTIME_LLM_BUDGET_TABLE} SET tokens = tokens + $2 WHERE key = ANY($1::text[])`, [keys, delta]);
    }
}
