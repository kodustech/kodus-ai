/**
 * Metering sweep — the invariants that make per-span billing safe:
 *  - only `kodus:`-routed spans inside the settled window are read;
 *  - a span is journaled ONCE (unique spanId; a re-read is a no-op) and priced
 *    at the catalog's list rate, cache-aware;
 *  - an unpriced model is journaled but never debited;
 *  - pending charges are debited in batches per team; a failed batch stays
 *    pending (retried next tick) and never advances to `debited`;
 *  - the cursor advances to the window's end on a full read, to the last span
 *    seen on a capped read.
 */
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

import {
    DEBIT_BATCH_SIZE,
    KodusCreditsMeteringService,
    SWEEP_INITIAL_LOOKBACK_MS,
    SWEEP_OVERLAP_MS,
    SWEEP_SETTLE_MS,
    SWEEP_SPAN_CAP,
} from './kodus-credits-metering.service';

/** Minimal chainable stand-in for a Mongoose query. */
const chain = (result: unknown) => {
    const q: any = {};
    q.sort = () => q;
    q.limit = () => q;
    q.lean = () => q;
    q.exec = async () => result;
    return q;
};

type Charge = {
    spanId: string;
    organizationId: string;
    teamId?: string;
    modelId: string;
    amountUsd: number;
    status: string;
    spanAt: Date;
    debitedAt?: Date;
    lastError?: string;
    [k: string]: unknown;
};

function harness(opts: {
    spans?: any[];
    cursor?: Date;
    charges?: Charge[];
    debit?: jest.Mock;
    orgParams?: any[];
}) {
    const charges: Charge[] = opts.charges ?? [];
    const telemetryModel = {
        aggregate: jest.fn(() => chain(opts.spans ?? [])),
    };
    const chargeModel = {
        updateOne: jest.fn(async (filter: any, update: any) => {
            const exists = charges.some((c) => c.spanId === filter.spanId);
            if (exists) return { upsertedCount: 0, matchedCount: 1 };
            charges.push({ ...update.$setOnInsert });
            return { upsertedCount: 1, matchedCount: 0 };
        }),
        find: jest.fn((filter: any) =>
            chain(
                charges.filter(
                    (c) =>
                        c.organizationId === filter.organizationId &&
                        (!filter.status || c.status === filter.status),
                ),
            ),
        ),
        updateMany: jest.fn(async (filter: any, update: any) => {
            const ids: string[] = filter.spanId.$in;
            for (const c of charges) {
                if (ids.includes(c.spanId)) Object.assign(c, update.$set);
            }
            return { modifiedCount: ids.length };
        }),
    };
    const sweepState: { cursor?: Date; lastSweepAt?: Date } = opts.cursor
        ? { cursor: opts.cursor }
        : {};
    const sweepStateModel = {
        findOne: jest.fn(() => chain(sweepState.cursor ? sweepState : null)),
        updateOne: jest.fn(async (_f: any, update: any) => {
            Object.assign(sweepState, update.$set);
            return {};
        }),
    };
    const orgParams = {
        find: jest.fn(async () => opts.orgParams ?? []),
    };
    const debit =
        opts.debit ??
        jest.fn(async (_org: any, entries: any[]) => ({
            applied: entries.length,
            skipped: 0,
            appliedUsd: entries.reduce((s, e) => s + e.amountUsd, 0),
            balanceUsd: 10,
            lowBalance: false,
            exhausted: false,
        }));
    const licenseService = { debitCredits: debit };

    const service = new KodusCreditsMeteringService(
        telemetryModel as any,
        chargeModel as any,
        sweepStateModel as any,
        orgParams as any,
        licenseService as any,
    );
    return { service, charges, telemetryModel, chargeModel, sweepState, debit, orgParams };
}

const NOW = new Date('2026-09-09T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const span = (
    id: string,
    over: Partial<{
        model: string;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        teamId: string;
        prNumber: number;
        at: Date;
    }> = {},
) => ({
    _id: id,
    correlationId: `run-${id}`,
    timestamp: over.at ?? minutesAgo(10),
    attributes: {
        teamId: over.teamId ?? 'team-1',
        prNumber: over.prNumber ?? 42,
        tu: {
            model: over.model ?? 'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
            input: over.input ?? 1_000_000,
            output: over.output ?? 100_000,
            reasoning: 0,
            cacheRead: over.cacheRead ?? 0,
            cacheWrite: over.cacheWrite ?? 0,
            total: (over.input ?? 1_000_000) + (over.output ?? 100_000),
            area: 'review',
            route: 'codeReview',
        },
    },
});

describe('listOrganizationsWithKodusCredential', () => {
    it('returns only orgs whose BYOK config has a kodus credential', async () => {
        const { service } = harness({
            orgParams: [
                {
                    organization: { uuid: 'org-kodus' },
                    configValue: {
                        version: 2,
                        credentials: [{ id: 'k', provider: 'kodus' }],
                        models: [],
                    },
                },
                {
                    organization: { uuid: 'org-own' },
                    configValue: {
                        version: 2,
                        credentials: [{ id: 'a', provider: 'anthropic', apiKey: 'x' }],
                        models: [],
                    },
                },
                { organization: { uuid: 'org-legacy' }, configValue: { main: {} } },
                { organization: undefined, configValue: null },
            ],
        });
        await expect(service.listOrganizationsWithKodusCredential()).resolves.toEqual([
            'org-kodus',
        ]);
    });
});

describe('sweepOrganization — journaling', () => {
    it('reads only kodus-routed, settled spans and journals each once at list price', async () => {
        const { service, charges, telemetryModel, debit } = harness({
            spans: [
                span('s1', { input: 1_000_000, output: 100_000, cacheRead: 400_000, cacheWrite: 100_000 }),
                span('s2', { model: 'fireworks/accounts/fireworks/models/deepseek-v4-pro-0813', input: 1_000_000, output: 0 }),
            ],
        });

        const summary = await service.sweepOrganization('org-1', NOW);

        // Query shape: org + settled window + kodus prefix + non-empty usage.
        const pipeline = (telemetryModel.aggregate.mock.calls[0] as any[])[0];
        const filter = pipeline[0].$match;
        expect(filter['attributes.organizationId']).toBe('org-1');
        // The model lives under a dotted key inside `attributes`, so the filter
        // must read it with $getField (a dot path silently matches nothing).
        expect(filter.$expr.$regexMatch.regex).toBe('^kodus:');
        expect(filter.$expr.$regexMatch.input.$ifNull[0].$getField).toEqual({
            field: 'gen_ai.response.model',
            input: '$attributes',
        });
        expect(filter['attributes.tu.total']).toEqual({ $gt: 0 });
        expect(filter.timestamp.$lte.getTime()).toBe(NOW.getTime() - SWEEP_SETTLE_MS);
        expect(filter.timestamp.$gt.getTime()).toBe(NOW.getTime() - SWEEP_INITIAL_LOOKBACK_MS);

        expect(summary.spansSeen).toBe(2);
        expect(summary.journaled).toBe(2);
        const s1 = charges.find((c) => c.spanId === 's1')!;
        // uncached 500K×$2 + read 400K×$0.2 + write 100K×$2.5 + out 100K×$10
        // flash: uncached 500K×0.22 + read 400K×0.007 + write 100K×0.22 (no write rate) + out 100K×0.66
        expect(s1.amountUsd).toBeCloseTo(0.2008, 6);
        expect(s1).toMatchObject({
            organizationId: 'org-1',
            teamId: 'team-1',
            correlationId: 'run-s1',
            prNumber: 42,
            modelId: 'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
            status: 'debited',
        });
        const s2 = charges.find((c) => c.spanId === 's2')!;
        expect(s2.amountUsd).toBeCloseTo(1.32, 6);

        // Debited in one batch for the team, usageKey = span:<id>.
        expect(debit).toHaveBeenCalledTimes(1);
        const [org, entries] = debit.mock.calls[0];
        expect(org).toEqual({ organizationId: 'org-1', teamId: 'team-1' });
        expect(entries.map((e: any) => e.usageKey)).toEqual(['span:s1', 'span:s2']);
        expect(summary.debited).toBe(2);
        expect(summary.debitedUsd).toBeCloseTo(1.5208, 6);
        expect(summary.balanceUsd).toBe(10);
    });

    it('a re-read span (overlap window) is not journaled or debited twice', async () => {
        const already: Charge = {
            spanId: 's1',
            organizationId: 'org-1',
            teamId: 'team-1',
            modelId: 'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
            amountUsd: 1,
            status: 'debited',
            spanAt: minutesAgo(30),
        };
        const { service, charges, debit } = harness({
            spans: [span('s1'), span('s9')],
            charges: [already],
            cursor: minutesAgo(5),
        });

        const summary = await service.sweepOrganization('org-1', NOW);

        expect(summary.journaled).toBe(1);
        expect(charges.filter((c) => c.spanId === 's1')).toHaveLength(1);
        const [, entries] = debit.mock.calls[0];
        expect(entries.map((e: any) => e.usageKey)).toEqual(['span:s9']);
    });

    it('re-reads from cursor − overlap, and advances the cursor to the window end', async () => {
        const cursor = minutesAgo(20);
        const { service, telemetryModel, sweepState } = harness({ spans: [], cursor });

        await service.sweepOrganization('org-1', NOW);

        const filter = (telemetryModel.aggregate.mock.calls[0] as any[])[0][0].$match;
        expect(filter.timestamp.$gt.getTime()).toBe(cursor.getTime() - SWEEP_OVERLAP_MS);
        expect(sweepState.cursor!.getTime()).toBe(NOW.getTime() - SWEEP_SETTLE_MS);
    });

    it('on a capped read the cursor stops at the last span seen (no gap)', async () => {
        const spans = Array.from({ length: SWEEP_SPAN_CAP }, (_, i) =>
            span(`s${i}`, { at: minutesAgo(60 - (i % 50)) }),
        );
        const last = new Date(Math.max(...spans.map((s) => s.timestamp.getTime())));
        const { service, sweepState } = harness({ spans });

        await service.sweepOrganization('org-1', NOW);

        expect(sweepState.cursor!.getTime()).toBe(last.getTime());
    });

    it('an unlisted model is journaled as unpriced and NEVER debited', async () => {
        const { service, charges, debit } = harness({
            spans: [span('s1', { model: 'anthropic/claude-sonnet-4-6' })],
        });

        const summary = await service.sweepOrganization('org-1', NOW);

        expect(summary.unpriced).toBe(1);
        expect(charges[0]).toMatchObject({ status: 'unpriced', amountUsd: 0 });
        expect(debit).not.toHaveBeenCalled();
    });
});

describe('sweepOrganization — debiting', () => {
    it('groups pending charges by team and batches at DEBIT_BATCH_SIZE', async () => {
        const pending: Charge[] = [];
        for (let i = 0; i < DEBIT_BATCH_SIZE + 3; i++) {
            pending.push({
                spanId: `a${i}`,
                organizationId: 'org-1',
                teamId: 'team-A',
                modelId: 'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
                amountUsd: 0.01,
                status: 'pending',
                spanAt: minutesAgo(30),
            });
        }
        pending.push({
            spanId: 'b0',
            organizationId: 'org-1',
            teamId: 'team-B',
            modelId: 'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
            amountUsd: 0.5,
            status: 'pending',
            spanAt: minutesAgo(30),
        });
        const { service, debit, charges } = harness({
            spans: [],
            charges: pending,
            cursor: minutesAgo(3),
        });

        const summary = await service.sweepOrganization('org-1', NOW);

        const calls = debit.mock.calls.map(([org, entries]: any) => [org.teamId, entries.length]);
        expect(calls).toEqual(
            expect.arrayContaining([
                ['team-A', DEBIT_BATCH_SIZE],
                ['team-A', 3],
                ['team-B', 1],
            ]),
        );
        expect(summary.debited).toBe(DEBIT_BATCH_SIZE + 4);
        expect(charges.every((c) => c.status === 'debited' && c.debitedAt)).toBe(true);
    });

    it('a failed debit leaves the batch pending (retried next tick) and records the error', async () => {
        const pending: Charge = {
            spanId: 'p1',
            organizationId: 'org-1',
            teamId: 'team-1',
            modelId: 'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
            amountUsd: 0.2,
            status: 'pending',
            spanAt: minutesAgo(30),
        };
        const debit = jest.fn().mockRejectedValue(new Error('billing 503'));
        const { service, charges } = harness({
            spans: [],
            charges: [pending],
            cursor: minutesAgo(3),
            debit,
        });

        const summary = await service.sweepOrganization('org-1', NOW);

        expect(summary.failed).toBe(1);
        expect(summary.debited).toBe(0);
        expect(charges[0]).toMatchObject({ status: 'pending', lastError: 'billing 503' });

        // Next tick: billing is back → the same charge is debited.
        debit.mockResolvedValue({ applied: 1, skipped: 0, appliedUsd: 0.2, balanceUsd: 1 });
        const again = await service.sweepOrganization('org-1', NOW);
        expect(again.debited).toBe(1);
        expect(charges[0].status).toBe('debited');
    });
});
