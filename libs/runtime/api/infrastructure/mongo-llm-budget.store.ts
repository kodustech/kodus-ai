import { randomUUID } from 'node:crypto';

import type { Collection, Db } from 'mongodb';

import { createLogger } from '@libs/core/log/logger';

import {
    LlmBudgetBusyError,
    type RuntimeLlmRunUsage,
    type RuntimeLlmSettledUsage,
    type RuntimeLlmSpendSnapshot,
    type RuntimeLlmUsageRecord,
    type RuntimeLlmUsageStore,
} from '../domain/ports';

/** Token counters of the three budget scopes, one document per scope key. */
export const RUNTIME_LLM_BUDGET_COLLECTION = 'runtime_llm_budget';
/** Calls in flight: what each reserved and on which counters, until it settles. */
export const RUNTIME_LLM_RESERVATIONS_COLLECTION = 'runtime_llm_reservations';

interface ModelSplit {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

interface CounterDoc {
    _id: string;
    tokens: number;
    /** Only the per-day counter expires; run and PR counters are the totals the dashboard reads. */
    expiresAt?: Date;
    /** Run counter only: settled tokens by model (modelKey), so the Run's cost is priced per model. */
    byModel?: Record<string, ModelSplit>;
}

/** A model id as a field name: no `.` or `$` (Mongo paths), and a key for "not reported". */
const NO_MODEL_KEY = 'none';
export const modelKey = (model: string | undefined) => (model ? `m_${encodeURIComponent(model).replace(/\./g, '%2E')}` : NO_MODEL_KEY);
const modelOfKey = (key: string) => (key.startsWith('m_') ? decodeURIComponent(key.slice(2)) : undefined);

interface ReservationDoc extends Omit<RuntimeLlmUsageRecord, 'inputTokens' | 'outputTokens'> {
    _id: string;
    counters: string[];
    tokens: number;
    expiresAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A reservation that never settles (a crash mid-call) is dropped after this; its tokens stay counted. */
const RESERVATION_TTL_MS = DAY_MS;
/** The per-day counter outlives its day so a call reserved at 23:59 still settles onto it. */
const ORG_DAY_TTL_MS = 2 * DAY_MS;
const MAX_ATTEMPTS = 12;

const part = (s: string | number) => encodeURIComponent(String(s));
export const runCounterKey = (runId: string) => `run/${part(runId)}`;
export const pullRequestCounterKey = (u: Pick<RuntimeLlmUsageRecord, 'organizationId' | 'repositoryId' | 'prNumber'>) =>
    `pr/${part(u.organizationId)}/${part(u.repositoryId)}/${part(u.prNumber)}`;
export const orgDayCounterKey = (organizationId: string, dayStart: Date) => `org-day/${part(organizationId)}/${dayStart.toISOString().slice(0, 10)}`;

const isDuplicateKey = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 11000;

/**
 * The gateway's budget (S-47) in the product Mongo. The consumption record of
 * each call is its usage span in `observability_telemetry` (LLM.run writes it,
 * with the Run's ids); this store keeps only what the budget needs: a counter
 * per scope and the reservations still in flight.
 *
 * Check and reserve is a compare-and-swap on each counter, the org's per-day
 * counter first. A call takes its tokens only from the counter values its
 * decision saw; when another call moved one of them in between, it gives back
 * what it took and decides again on the new values. So concurrent calls of one
 * org never pass a limit together. Every failure in between (a crash, a lost
 * give-back) leaves tokens counted, which errs on the side of spending less.
 */
export class MongoRuntimeLlmBudgetStore implements RuntimeLlmUsageStore {
    private readonly logger = createLogger(MongoRuntimeLlmBudgetStore.name);
    private ready?: Promise<{ counters: Collection<CounterDoc>; reservations: Collection<ReservationDoc> }>;

    constructor(
        private readonly db: () => Promise<Db>,
        private readonly pause: (attempt: number) => Promise<void> = (attempt) =>
            new Promise((resolve) => setTimeout(resolve, Math.random() * 5 * (attempt + 1))),
    ) {}

    async reserve(input: Parameters<RuntimeLlmUsageStore['reserve']>[0]) {
        const { counters, reservations } = await this.collections();
        const u = input.usage;
        const scope = {
            run: runCounterKey(u.runId),
            pullRequest: pullRequestCounterKey(u),
            orgToday: orgDayCounterKey(u.organizationId, input.orgDayStart),
        };
        // The per-day counter first: every call of the org passes through it, so
        // it is where concurrent calls of one org meet.
        const keys = [scope.orgToday, scope.pullRequest, scope.run];
        const dayExpiry = new Date(input.orgDayStart.getTime() + ORG_DAY_TTL_MS);

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const seen = new Map((await counters.find({ _id: { $in: keys } }).toArray()).map((d) => [d._id, d.tokens]));
            const spend: RuntimeLlmSpendSnapshot = {
                run: seen.get(scope.run) ?? 0,
                pullRequest: seen.get(scope.pullRequest) ?? 0,
                orgToday: seen.get(scope.orgToday) ?? 0,
            };
            const tokens = input.decide(spend);
            if (tokens === null) return null;
            if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error(`a reservation must be a whole number of tokens, got ${tokens}`);

            const taken: string[] = [];
            for (const key of keys) {
                if (!(await this.swap(counters, key, seen.get(key), tokens, key === scope.orgToday ? dayExpiry : undefined))) break;
                taken.push(key);
            }
            if (taken.length < keys.length) {
                await this.add(counters, taken, -tokens);
                await this.pause(attempt);
                continue;
            }

            const reservationId = randomUUID();
            try {
                await reservations.insertOne({ _id: reservationId, ...u, counters: keys, tokens, expiresAt: new Date(u.at.getTime() + RESERVATION_TTL_MS) });
            } catch (e) {
                // Without the reservation nothing could settle or cancel these tokens: give them back and refuse the call.
                await this.add(counters, keys, -tokens);
                throw e;
            }
            return { reservationId, tokens };
        }
        this.logger.warn({
            message: 'Runtime LLM budget contended; the call was not reserved',
            context: MongoRuntimeLlmBudgetStore.name,
            metadata: { runId: u.runId, organizationId: u.organizationId, attempts: MAX_ATTEMPTS },
        });
        throw new LlmBudgetBusyError();
    }

    async settle(reservationId: string, actual: RuntimeLlmSettledUsage): Promise<void> {
        const r = await this.release(reservationId, 'settle', (reserved) => actual.inputTokens + actual.outputTokens - reserved);
        if (!r) return;
        // The split is for the Run's cost only; the budget decided on the counter above.
        const n = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
        const key = `byModel.${modelKey(actual.model)}`;
        const { counters } = await this.collections();
        await counters.updateOne(
            { _id: runCounterKey(r.runId) },
            {
                $inc: {
                    [`${key}.input`]: n(actual.inputTokens),
                    [`${key}.output`]: n(actual.outputTokens),
                    [`${key}.cacheRead`]: n(actual.cacheReadTokens),
                    [`${key}.cacheWrite`]: n(actual.cacheWriteTokens),
                },
            },
        );
    }

    async cancel(reservationId: string): Promise<void> {
        await this.release(reservationId, 'cancel', (reserved) => -reserved);
    }

    async totalForRun(runId: string): Promise<number> {
        const { counters } = await this.collections();
        return (await counters.findOne({ _id: runCounterKey(runId) }))?.tokens ?? 0;
    }

    async usageForRuns(runIds: string[]): Promise<Map<string, RuntimeLlmRunUsage>> {
        const out = new Map<string, RuntimeLlmRunUsage>();
        const ids = [...new Set(runIds)];
        if (!ids.length) return out;
        const { counters } = await this.collections();
        const byKey = new Map(ids.map((id) => [runCounterKey(id), id]));
        // By _id only, bounded by the page of Runs asked for.
        for (const d of await counters.find({ _id: { $in: [...byKey.keys()] } }).toArray()) {
            const runId = byKey.get(d._id);
            if (!runId) continue;
            out.set(runId, {
                tokens: d.tokens,
                byModel: Object.entries(d.byModel ?? {}).map(([k, v]) => ({
                    model: modelOfKey(k),
                    inputTokens: v.input ?? 0,
                    outputTokens: v.output ?? 0,
                    cacheReadTokens: v.cacheRead ?? 0,
                    cacheWriteTokens: v.cacheWrite ?? 0,
                })),
            });
        }
        return out;
    }

    /** Takes the reservation once (a second settle finds nothing), then moves its counters by the difference. */
    private async release(reservationId: string, op: 'settle' | 'cancel', delta: (reserved: number) => number): Promise<ReservationDoc | null> {
        const { counters, reservations } = await this.collections();
        const r = await reservations.findOneAndDelete({ _id: reservationId });
        if (!r) {
            this.logger.warn({
                message: 'Runtime LLM reservation not found; it settled already or expired',
                context: MongoRuntimeLlmBudgetStore.name,
                metadata: { reservationId, op },
            });
            return null;
        }
        await this.add(counters, r.counters, delta(r.tokens));
        return r;
    }

    /** Adds `tokens` to the counter only if it still holds `seen` (absent when the decision saw none). */
    private async swap(counters: Collection<CounterDoc>, key: string, seen: number | undefined, tokens: number, expiresAt?: Date): Promise<boolean> {
        try {
            if (seen === undefined) {
                await counters.insertOne({ _id: key, tokens, ...(expiresAt ? { expiresAt } : {}) });
                return true;
            }
            return (await counters.updateOne({ _id: key, tokens: seen }, { $inc: { tokens } })).matchedCount === 1;
        } catch (e) {
            if (isDuplicateKey(e)) return false;
            throw e;
        }
    }

    private async add(counters: Collection<CounterDoc>, keys: string[], delta: number) {
        if (!keys.length || delta === 0) return;
        await counters.updateMany({ _id: { $in: keys } }, { $inc: { tokens: delta } });
    }

    private collections() {
        this.ready ??= this.open().catch((e) => {
            this.ready = undefined;
            throw e;
        });
        return this.ready;
    }

    private async open() {
        const db = await this.db();
        const counters = db.collection<CounterDoc>(RUNTIME_LLM_BUDGET_COLLECTION);
        const reservations = db.collection<ReservationDoc>(RUNTIME_LLM_RESERVATIONS_COLLECTION);
        // Cleanup only: the budget is right without them, so a failure is logged, not fatal.
        await Promise.all([
            counters.createIndex({ expiresAt: 1 }, { name: 'ttl_expiresAt', expireAfterSeconds: 0 }),
            reservations.createIndex({ expiresAt: 1 }, { name: 'ttl_expiresAt', expireAfterSeconds: 0 }),
        ]).catch((e) =>
            this.logger.warn({
                message: 'Runtime LLM budget TTL indexes not created',
                context: MongoRuntimeLlmBudgetStore.name,
                error: e instanceof Error ? e : undefined,
            }),
        );
        return { counters, reservations };
    }
}
