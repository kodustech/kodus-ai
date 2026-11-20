import { FakeEnvironmentRuntime, type EnvironmentRuntime } from '@libs/runtime/environment';
import { checkIntentProbes } from '@libs/runtime/planner/intent-author';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { HmacCanaryVault } from '../canary/canary';
import { inMemoryRunDeps } from './testing';
import { acquireRequest, finalizeStoppedRun, runRuntimeRun } from './run-orchestrator';

// A resumed workflow replays its steps by id, in order (DBOS matches each
// recorded step by its place and name). So on every path a Run's body asks
// for each step id once, and a replay from the recorded steps asks for the
// same ids in the same order without running any step again. Which ids a
// release uses is its own (DBOS keeps a Run on the release that started it).

const vault = new HmacCanaryVault();

const KEPT_ID = '6f1c1d3e-2b7a-4c55-9a0e-3d2f4b5a6c7d';
const keptCheck = {
    keptCheckId: KEPT_ID,
    entryPoint: 'GET /orders/:id',
    probe: { spec: { kind: 'http' as const, target: { service: 'web', port: 3000 }, method: 'GET' as const, path: '/orders/1', timeoutMs: 5_000 }, purpose: 'order 1 totals 3', expected: '200', compare: ['status' as const, 'json' as const] },
    assertions: { kind: 'http' as const, status: 200 },
    differingFields: ['json.total'],
    sourcePrNumber: 7,
};

type Blocker = { kind: string; signature: string; message: string };

/** A PR side that takes a while to boot, its build started from the start: the agent plans meanwhile. */
const prBootsWhileThePlanRuns = (prBlocked?: Blocker): EnvironmentRuntime => {
    const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
    const acquire = env.acquire.bind(env);
    env.acquire = async (r) => {
        if (r.ref.side !== 'pr') return acquire(r);
        await new Promise((done) => setTimeout(done, 30));
        return (prBlocked ? { status: 'blocked', blockers: [prBlocked] } : await acquire(r)) as never;
    };
    Object.assign(env, {
        progress: async () => ({ phases: [{ phase: 'compose', state: 'started', at: new Date().toISOString() }], lines: [], updatedAt: new Date().toISOString() }),
    });
    return env;
};

const prBlockedBy = (blocker: Blocker): EnvironmentRuntime => {
    const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
    const acquire = env.acquire.bind(env);
    env.acquire = async (r) => (r.ref.side === 'pr' ? { status: 'blocked', blockers: [blocker] } : acquire(r)) as never;
    return env;
};

/** The Run once from the start, then replayed from its recorded steps: the ids each asked for, and the steps the replay ran. */
async function runAndReplay(req: ReturnType<typeof shopRunRequest>, env?: EnvironmentRuntime, arrange?: (h: ReturnType<typeof inMemoryRunDeps>) => void) {
    const h = inMemoryRunDeps(env ? { env, canaries: vault } : { canaries: vault });
    arrange?.(h);
    await h.projection.upsert(req.runId, {
        attempt: req.attempt,
        correlationId: req.correlationId,
        organizationId: req.organizationId,
        teamId: req.teamId,
        repositoryId: req.repository.id,
        repositoryName: req.repository.name,
        prNumber: req.pullRequest.number,
        headSha: req.pullRequest.headSha,
        baseSha: req.pullRequest.baseSha,
        environmentId: req.environment.environmentId,
        imageId: req.environment.imageId,
        state: 'queued',
        requestedAt: req.requestedAt,
    });
    // As DBOS records a step: its output, or the error it threw (replayed as thrown).
    const recorded = new Map<string, { out: unknown } | { error: unknown }>();
    const step = h.deps.step;
    let asked: string[] = [];
    let ran = 0;
    h.deps.step = async (name, fn) => {
        asked.push(name);
        const seen = recorded.get(name);
        if (seen) {
            if ('error' in seen) throw seen.error;
            return structuredClone(seen.out) as never;
        }
        ran++;
        try {
            const out = await step(name, fn);
            recorded.set(name, { out: structuredClone(out) });
            return out;
        } catch (error) {
            recorded.set(name, { error });
            throw error;
        }
    };
    const first = await runRuntimeRun(req, h.deps);
    const firstIds = asked;
    asked = [];
    ran = 0;
    const replay = await runRuntimeRun(req, h.deps);
    return { first, firstIds, replay, replayIds: asked, replayRan: ran };
}

describe('a Run replayed from its recorded steps asks for the same step ids, each once, and runs none again', () => {
    const cases: Array<[string, () => Parameters<typeof runAndReplay>]> = [
        ['a Run that tests and finds a regression', () => [shopRunRequest()]],
        ['a Run whose base does not boot', () => [shopRunRequest({ environment: { environmentId: 'broken', imageId: 'img-shop-1', expose: [] } })]],
        ['a Run whose PR alone does not boot', () => [shopRunRequest(), prBlockedBy({ kind: 'toolchain', signature: 'node-24', message: 'x' })]],
        ['a Run whose PR the cell could not start', () => [shopRunRequest(), prBlockedBy({ kind: 'platform', signature: 'builder_failed', message: 'docker could not run the builder (exit 125)' })]],
        ['a Run whose PR boots while the agent plans', () => [shopRunRequest(), prBootsWhileThePlanRuns()]],
        ['a Run whose PR does not boot after the agent planned', () => [shopRunRequest(), prBootsWhileThePlanRuns({ kind: 'toolchain', signature: 'node-24', message: 'x' })]],
        ['a Run halted by a claim compromised during the boot', () => [shopRunRequest(), prBlockedBy({ kind: 'security_violation', signature: 'credential_exfiltration', message: 'x' })]],
        [
            'a Run whose PR cell is lost while acquiring',
            () => {
                const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
                const acquire = env.acquire.bind(env);
                env.acquire = async (r) => {
                    if (r.ref.side === 'pr') throw new Error('transport lost');
                    return acquire(r);
                };
                return [shopRunRequest(), env];
            },
        ],
        [
            'a Run halted by a canary in a blocked outbound host after the replay',
            () => {
                const req = shopRunRequest();
                const [, , seedRow] = vault.forRun(req);
                return [
                    req,
                    undefined,
                    (h) => {
                        const record = h.claims.record.bind(h.claims);
                        h.claims.record = async (c) => {
                            await record(c);
                            if (c.side === 'pr') h.claims.egress.push({ claimId: c.claimId, host: `${seedRow.core}.exfil.example.test`, port: 53, phase: 'test' });
                        };
                    },
                ];
            },
        ],
        [
            'a Run that plays a kept check after its plan and records the outcome',
            () => {
                const env = new FakeEnvironmentRuntime(
                    { ...SCENARIOS, shop: { ...SCENARIOS.shop, probes: { ...SCENARIOS.shop.probes, [`kept:${KEPT_ID}`]: { base: () => ({ http: { status: 200, headers: {}, body: '{"total":3}' } }), pr: () => ({ http: { status: 200, headers: {}, body: '{"total":4}' } }) } } } },
                    () => new Date(),
                );
                return [shopRunRequest({ keptChecks: [keptCheck] }), env, (h) => void (h.deps.keptCheckResults = { record: async () => undefined })];
            },
        ],
        [
            'a Run that checks what the PR describes: one intent probe of a planned request, one of its own after the kept check',
            () => {
                const answer = (status: number, body: unknown) => () => ({ http: { status, headers: {}, body: JSON.stringify(body) } });
                const env = new FakeEnvironmentRuntime(
                    {
                        ...SCENARIOS,
                        shop: {
                            ...SCENARIOS.shop,
                            probes: {
                                ...SCENARIOS.shop.probes,
                                [`kept:${KEPT_ID}`]: { base: answer(200, { total: 3 }), pr: answer(200, { total: 3 }) },
                                'intent-2': { base: answer(404, { error: 'not found' }), pr: answer(200, { id: 7, total: 9 }) },
                            },
                        },
                    },
                    () => new Date(),
                );
                const description = '- `GET /orders` still lists the orders.\n- `GET /orders/7` answers its total, 10.';
                const text = JSON.stringify({
                    probes: [
                        { quote: '`GET /orders` still lists the orders.', source: 'description', request: { method: 'GET', path: '/orders' }, assertions: [{ kind: 'status', status: 200 }] },
                        { quote: '`GET /orders/7` answers its total, 10.', source: 'description', request: { method: 'GET', path: '/orders/7' }, assertions: [{ kind: 'equals', path: '$.total', value: 10 }] },
                    ],
                });
                return [
                    shopRunRequest({ keptChecks: [keptCheck], pullRequest: { ...shopRunRequest().pullRequest, description } }),
                    env,
                    (h) => {
                        h.deps.keptCheckResults = { record: async () => undefined };
                        h.deps.intentAuthor = { author: async (input) => ({ status: 'authored', version: 'test', probes: checkIntentProbes(text, input).probes, dropped: [], usage: { inputTokens: 1, outputTokens: 1 } }) };
                    },
                ];
            },
        ],
    ];

    it.each(cases)('%s', async (_name, args) => {
        const r = await runAndReplay(...args());
        if (/intent probe/.test(_name)) {
            expect(r.firstIds).toContain('intent:author');
            // The plan's 2 probes, the kept check at 2, then the intent probes from 3 in their order: intent-1 (a twin of
            // GET /orders) keeps index 3 and plays nothing, intent-2 plays at 4.
            expect(r.firstIds.filter((id) => id.includes(':intent-'))).toEqual(expect.arrayContaining(['probe:4:intent-2:base:1', 'probe:4:intent-2:pr:1']));
            expect(r.firstIds.some((id) => id.includes(':intent-1:'))).toBe(false);
        }
        expect(new Set(r.firstIds).size).toBe(r.firstIds.length);
        expect(r.replayIds).toEqual(r.firstIds);
        expect(r.replayRan).toBe(0);
        expect(r.replay.state).toBe(r.first.state);
    });
});

describe('the plan made while the PR boots', () => {
    // DBOS numbers steps in the order they start: the plan's step has the same place whether the PR side is fast or slow.
    it('starts the same steps in the same order whether the PR side boots before or after the plan', async () => {
        const fast = await runAndReplay(shopRunRequest());
        const slow = await runAndReplay(shopRunRequest(), prBootsWhileThePlanRuns());
        // Every step before the replay keeps its place. A probe's first base round played while the PR built is
        // inside agent:plan:early, not a step of its own (the replay reads which ones from that step's record,
        // run-base-ahead.spec.ts), so the replay's rounds are the same less those, paired differently.
        const beforeReplay = (ids: string[]) => ids.slice(0, ids.findIndex((id) => id.startsWith('probe:')));
        const replayed = (ids: string[]) => ids.filter((id) => id.startsWith('probe:') && !/:base:1$/.test(id)).sort();
        expect(beforeReplay(slow.firstIds)).toEqual(beforeReplay(fast.firstIds));
        expect(replayed(slow.firstIds)).toEqual(replayed(fast.firstIds));
        expect(fast.firstIds.indexOf('agent:plan:early')).toBe(fast.firstIds.indexOf('acquire:pr:1') + 1);
        expect(fast.firstIds).not.toContain('agent:plan');
    });
});

describe('a replayed Run', () => {
    it('counts its duration once: the metric is recorded inside a step', async () => {
        const req = shopRunRequest();
        const h = inMemoryRunDeps();
        const checkpoints = new Map<string, unknown>();
        const step = h.deps.step;
        h.deps.step = async (name, fn) => {
            if (checkpoints.has(name)) return checkpoints.get(name) as never;
            const out = await step(name, fn);
            checkpoints.set(name, out);
            return out;
        };
        const durations = jest.spyOn(h.deps.metrics, 'recordRunDuration');
        await runRuntimeRun(req, h.deps);
        expect(durations).toHaveBeenCalledTimes(1);
        // The workflow runs again from its checkpoints, as DBOS recovers it.
        await runRuntimeRun(req, h.deps);
        expect(durations).toHaveBeenCalledTimes(1);
    });
});

describe('the acquire of each side', () => {
    it('marks the PR side of a fork, and only it, so the hub keeps the approved egress hosts from it', async () => {
        const run = async (fork: boolean) => {
            const h = inMemoryRunDeps();
            const acquired = jest.spyOn(h.deps.env, 'acquire');
            const base = shopRunRequest();
            const req = { ...base, pullRequest: { ...base.pullRequest, fork, forkApprovalRequired: false } };
            await runRuntimeRun(req, h.deps, { forkApproved: true });
            return acquired.mock.calls.map(([r]) => ({ side: r.ref.side, forkPullRequest: r.forkPullRequest }));
        };
        expect(await run(true)).toEqual([
            { side: 'base', forkPullRequest: undefined },
            { side: 'pr', forkPullRequest: true },
        ]);
        expect(await run(false)).toEqual([
            { side: 'base', forkPullRequest: undefined },
            { side: 'pr', forkPullRequest: undefined },
        ]);
    });
});

describe('round snapshots (RUNTIME_ROUND_SNAPSHOTS)', () => {
    async function run(opts: { rounds: boolean; refuse?: boolean }) {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        if (opts.refuse) env.snapshotRound = async (_c, stepId) => ({ code: 'transport_lost', stepId });
        const taken = jest.spyOn(env, 'snapshotRound');
        const r = await runAndReplay(shopRunRequest(), env, (h) => {
            if (opts.rounds) h.deps.roundSnapshots = true;
        });
        return { ...r, env, taken };
    }

    it('takes each side round inside its acquire step, so the step ids and their order do not change', async () => {
        const off = await run({ rounds: false });
        const on = await run({ rounds: true });
        expect(on.firstIds).toEqual(off.firstIds);
        expect(on.replayIds).toEqual(on.firstIds);
        expect(on.replayRan).toBe(0);
        expect(on.taken).toHaveBeenCalledTimes(2);
        expect(off.taken).not.toHaveBeenCalled();
        expect(on.replay.state).toBe(off.replay.state);
    });

    it("sends each side's round with every reset of that side, read back from the acquire's checkpoint on a replay", async () => {
        const on = await run({ rounds: true });
        // Each side's round, as its acquire step took it (the release at the end removed them).
        const rounds = new Map<string, string>();
        for (const [i, [claimId]] of on.taken.mock.calls.entries()) {
            const r = await on.taken.mock.results[i].value;
            rounds.set(claimId, r.id);
        }
        expect(rounds.size).toBe(2);
        expect(on.env.resets.length).toBeGreaterThan(0);
        on.env.resets.forEach((claimId, i) => expect(on.env.resetRounds[i]).toBe(rounds.get(claimId)));
        expect(on.env.rounds.size).toBe(0);
    });

    it('keeps the compose reset when the flag is off or the cell refuses the round', async () => {
        for (const r of [await run({ rounds: false }), await run({ rounds: true, refuse: true })]) {
            expect(r.env.resets.length).toBeGreaterThan(0);
            expect(r.env.resetRounds.every((x) => x === undefined)).toBe(true);
        }
    });

    it('takes the round before the agent plans or explores, at the state of first ready', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const taken = jest.spyOn(env, 'snapshotRound');
        const h = inMemoryRunDeps({ env, canaries: vault });
        h.deps.roundSnapshots = true;
        const planned = jest.spyOn(h.deps.agent, 'plan');
        await runRuntimeRun(shopRunRequest(), h.deps);
        expect(planned).toHaveBeenCalled();
        expect(Math.max(...taken.mock.invocationCallOrder)).toBeLessThan(Math.min(...planned.mock.invocationCallOrder));
    });
});

describe('a Run side\'s round when the Run ends early', () => {
    it("is released with its claim when the PR closes mid-Run (cancelled, pr_closed): nothing of the PR's machine is kept", async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const h = inMemoryRunDeps({ env, canaries: vault });
        const req = shopRunRequest();
        await h.projection.upsert(req.runId, {
            attempt: req.attempt, correlationId: req.correlationId, organizationId: req.organizationId, teamId: req.teamId,
            repositoryId: req.repository.id, repositoryName: req.repository.name, prNumber: req.pullRequest.number,
            headSha: req.pullRequest.headSha, baseSha: req.pullRequest.baseSha, environmentId: req.environment.environmentId,
            imageId: req.environment.imageId, state: 'testing', requestedAt: req.requestedAt,
        });
        // Both sides acquired and kept as rounds, as the acquire steps do with the flag on.
        for (const side of ['base', 'pr'] as const) {
            const claim = await h.deps.env.acquire(acquireRequest(req, side));
            if ('status' in claim) throw new Error('blocked');
            const round = await h.deps.env.snapshotRound!(claim.claimId, `00000000-0000-4000-8000-00000000000${side === 'base' ? 1 : 2}`);
            expect(round).toHaveProperty('id');
        }
        expect(env.rounds.size).toBe(2);
        expect(await finalizeStoppedRun(h.deps, { ...req, headSha: req.pullRequest.headSha }, 'cancelled', 'pr_closed')).toBe(true);
        expect(await h.deps.claims.forRun(req.organizationId, req.runId)).toEqual([]);
        expect(env.rounds.size).toBe(0);
    });
});
