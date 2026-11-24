import { parseHostPool } from '@libs/runtime/fleet/pool';
import { ProviderError } from '@libs/runtime/fleet/provider-error';
import { FakeHostProvider } from '@libs/runtime/fleet/testing';
import { devSealKey } from '../testing/dev-seal-key';

import { fleetHostId } from './fleet-store';
import { runPerRunHost, type PerRunHostDeps } from './per-run-host';
import { FakeClock, FakeHubFleet, FixedTemplates, InMemoryFleetStore, RecordingSteps } from './testing';

const pool = (provider: 'fake' | 'boat' = 'fake', base?: string) =>
    parseHostPool({
        kind: 'HostPool',
        name: 'boat-eu-perrun',
        scope: 'kodus',
        provider,
        lifecycle: 'perRun',
        hostClass: provider === 'boat' ? { kind: 'HostClass', name: 'boat-large-cell', provider: 'boat', boat: { type: 'large', ...(base ? { base } : {}) } } : { kind: 'HostClass', name: 'fake', provider: 'fake' },
        perRun: { registrationTimeoutSeconds: 600, maxRunMinutes: 120 },
    });

/** A perRun pool with one Run waiting for its host, and everything the workflow talks to. */
function world(opts: { provider?: 'fake' | 'boat'; base?: string; template?: string | null; registersAfterMs?: number | null; boundKey?: string } = {}) {
    const clock = new FakeClock();
    const store = new InMemoryFleetStore(clock);
    const poolId = store.addPool(pool(opts.provider ?? 'fake', opts.base));
    const boundKey = opts.boundKey ?? 'run:org-a/r-1';
    store.addDemand({ poolId, boundKey, organizationId: 'org-a', environmentId: 'env-1', runId: 'r-1' });
    const provider = new FakeHostProvider({ installation: 'it', startState: 'running' });
    const hub = new FakeHubFleet();
    const hostId = fleetHostId(poolId, boundKey);
    const bootedAt = { t: 0 };
    // The cell registers a while after the host is created, unless the test says it never does.
    const steps = new RecordingSteps(clock, () => {
        const created = [...provider.hosts.values()].some((h) => h.tags.host === hostId);
        if (created && !bootedAt.t) bootedAt.t = clock.t;
        if (opts.registersAfterMs !== null && bootedAt.t && clock.t - bootedAt.t >= (opts.registersAfterMs ?? 20_000)) store.connected.add(hostId);
    });
    const deps: PerRunHostDeps = {
        step: steps.step,
        sleep: steps.sleep,
        now: clock.now,
        store,
        hub,
        providerFor: (kind) => (kind === 'fake' || kind === 'boat' ? provider : undefined),
        templates: new FixedTemplates(opts.template === undefined ? 'kodus-env-a1-b2-c3' : opts.template),
        installation: 'it',
        bootstrap: { hubUrl: 'https://hub.example:3410', hubCa: 'CA' },
        sealKey: devSealKey(),
    };
    const input = { hostId, poolId, boundKey, organizationId: 'org-a', environmentId: 'env-1' };
    /** The Run stops asking for the host (its demand expires) once the clock passes `at`. */
    const runEndsAt = (at: number) => {
        const d = store.demand.get(`${poolId}\n${boundKey}`)!;
        d.expiresAt = at;
    };
    return { clock, store, provider, hub, steps, deps, input, hostId, poolId, boundKey, runEndsAt };
}

describe('the perRun host workflow', () => {
    // docs/runtime/e2e-suites.md section 5: one host per shard of a suite run, kept for the re-run, gone with the suite.
    it("a suite shard's host boots from the environment's template and stays up between its first pass and its re-run, while no claim holds it, until the suite run ends its demand", async () => {
        const w = world({ provider: 'boat', boundKey: 'suite:org-a/sr-1/0' });
        const suiteEndsAt = w.clock.t + 40 * 60_000;
        w.runEndsAt(suiteEndsAt);
        const hostState: Array<{ at: number; provider: string }> = [];
        const sleep = w.deps.sleep;
        w.deps.sleep = async (ms) => {
            await sleep(ms);
            const elapsed = w.clock.t - (suiteEndsAt - 40 * 60_000);
            // first pass from minute 2 to 12, nothing for 8 minutes (the other shards finish), the re-run from 20 to 24.
            w.store.claims.set(w.hostId, (elapsed >= 2 * 60_000 && elapsed < 12 * 60_000) || (elapsed >= 20 * 60_000 && elapsed < 24 * 60_000) ? 1 : 0);
            hostState.push({ at: elapsed, provider: [...w.provider.hosts.values()][0]?.state ?? 'none' });
        };
        expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'served' });
        expect([...w.provider.hosts.values()][0].from).toBe('kodus-env-a1-b2-c3');
        expect(w.provider.hosts.size).toBe(1);
        // Up through the gap with no claim; only the end of the suite's demand (minute 40) retires it.
        expect(hostState.filter((h) => h.at < 39 * 60_000).every((h) => h.provider === 'running')).toBe(true);
        expect(w.hub.retired).toEqual([w.hostId]);
        expect(w.store.events.map((e) => e.to).slice(-2)).toEqual(['terminating', 'terminated']);
    });

    it('creates one host from the template with a single-use token, serves the Run until it stops asking, then retires the cell and destroys the host', async () => {
        const w = world();
        w.runEndsAt(w.clock.t + 30 * 60_000);
        const r = await runPerRunHost(w.input, w.deps);
        expect(r).toEqual({ outcome: 'served' });
        const [host] = [...w.provider.hosts.values()];
        expect(w.provider.hosts.size).toBe(1);
        expect(host.from).toBe('kodus-env-a1-b2-c3');
        expect(host.bootstrap).toEqual({ hubUrl: 'https://hub.example:3410', hubCa: 'CA', token: w.hub.minted[0].token });
        expect(host.state).toBe('gone');
        expect(w.hub.retired).toEqual([w.hostId]);
        expect(w.store.hosts.get(w.hostId)!.state).toBe('terminated');
        expect(w.store.events.map((e) => e.to)).toEqual(['requested', 'provisioning', 'bootstrapping', 'ready', 'terminating', 'terminated']);
    });

    it('never keeps a usable token in a step output: it is sealed to the host', async () => {
        const w = world();
        w.runEndsAt(w.clock.t + 60_000);
        await runPerRunHost(w.input, w.deps);
        expect(JSON.stringify([...w.steps.outputs.values()])).not.toContain(w.hub.minted[0].token);
    });

    it('pushes the dead-man TTL forward while the Run lives', async () => {
        const w = world();
        w.runEndsAt(w.clock.t + 30 * 60_000);
        await runPerRunHost(w.input, w.deps);
        expect(w.provider.calls.filter((c) => c.op === 'extend').length).toBeGreaterThanOrEqual(5);
    });

    it('a host whose cell never registers is destroyed at the registration timeout and its Run is told why', async () => {
        const w = world({ registersAfterMs: null });
        const r = await runPerRunHost(w.input, w.deps);
        expect(r).toEqual({ outcome: 'failed', failure: 'registration_timeout' });
        expect(w.store.demand.get(`${w.poolId}\n${w.boundKey}`)!.failure).toBe('registration_timeout');
        expect([...w.provider.hosts.values()][0].state).toBe('gone');
        expect(w.store.hosts.get(w.hostId)!.state).toBe('terminated');
        expect(w.store.pools.get(w.poolId)!.status.consecutiveFailures).toBe(1);
    });

    it('a boat pool with no template for the environment fails before any create', async () => {
        const w = world({ provider: 'boat', template: null });
        expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'failed', failure: 'template_missing' });
        expect(w.provider.calls.filter((c) => c.op === 'create')).toEqual([]);
        expect(w.hub.minted).toEqual([]);
    });

    it("a boat Run host of an environment with no template of its own starts from the pool's cell base: the Run builds cold instead of failing", async () => {
        const w = world({ provider: 'boat', base: 'kodus-cell-r42-gvisor', template: null });
        w.runEndsAt(w.clock.t + 60_000);
        expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'served' });
        expect([...w.provider.hosts.values()].map((h) => h.from)).toEqual(['kodus-cell-r42-gvisor']);
    });

    it("the environment's own template wins over the cell base", async () => {
        const w = world({ provider: 'boat', base: 'kodus-cell-r42-gvisor' });
        w.runEndsAt(w.clock.t + 60_000);
        await runPerRunHost(w.input, w.deps);
        expect([...w.provider.hosts.values()].map((h) => h.from)).toEqual(['kodus-env-a1-b2-c3']);
    });

    it('a throttled create waits what the provider asked and retries with the same client token: one host', async () => {
        const w = world();
        w.runEndsAt(w.clock.t + 60_000);
        w.provider.failNext('create', new ProviderError('throttled', 'rate_limited', { retryAfterMs: 30_000, window: 'minute' }));
        const before = w.clock.t;
        expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'served' });
        expect(w.provider.hosts.size).toBe(1);
        expect(w.provider.calls.filter((c) => c.op === 'create').length).toBe(2);
        expect(w.clock.t - before).toBeGreaterThanOrEqual(30_000);
    });

    it('a create the provider refuses for good fails the host without a second try', async () => {
        const w = world();
        w.provider.failNext('create', new ProviderError('unauthorized', 'unauthorized', { status: 401 }));
        expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'failed', failure: 'provider_refused' });
        expect(w.provider.calls.filter((c) => c.op === 'create').length).toBe(1);
        expect(w.hub.retired).toEqual([w.hostId]);
    });

    it('a Run that keeps asking past maxRunMinutes loses its host: the dead-man bound holds even when the Run does not end', async () => {
        const w = world();
        w.runEndsAt(w.clock.t + 24 * 3_600_000);
        expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'expired' });
        expect([...w.provider.hosts.values()][0].state).toBe('gone');
    });

    it('a process that dies anywhere resumes the same workflow and still makes one host', async () => {
        for (let crashAt = 1; crashAt < 16; crashAt++) {
            const w = world();
            w.runEndsAt(w.clock.t + 60_000);
            w.steps.crashAfter = crashAt;
            void runPerRunHost(w.input, w.deps);
            await w.steps.crashed;
            expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'served' });
            expect(w.provider.hosts.size).toBe(1);
            expect(w.hub.minted.length).toBe(1);
        }
    });

    it('a create that reached the provider but whose answer was never kept is sent again with the same token and client token: one host', async () => {
        for (const step of ['token', 'create:0', 'host.bootstrapping']) {
            const w = world();
            w.runEndsAt(w.clock.t + 60_000);
            w.steps.crashInside = step;
            void runPerRunHost(w.input, w.deps);
            await w.steps.crashed;
            expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'served' });
            expect(w.provider.hosts.size).toBe(1);
            // A mint whose answer was lost mints again; the hub replaces the unused token, so only the second is live.
            const used = [...w.provider.hosts.values()][0].bootstrap!.token;
            expect(used).toBe(w.hub.minted[w.hub.minted.length - 1].token);
        }
    });

    it('a host lost while it serves (its cell gone) is destroyed and the Run is told', async () => {
        const w = world();
        w.runEndsAt(w.clock.t + 30 * 60_000);
        const sleep = w.deps.sleep;
        w.deps.sleep = async (ms) => {
            await sleep(ms);
            if (w.store.hosts.get(w.hostId)?.state === 'ready' && w.clock.t > Date.parse('2026-11-17T12:10:00Z')) w.store.connected.delete(w.hostId);
        };
        expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'failed', failure: 'host_lost' });
        expect(w.store.demand.get(`${w.poolId}\n${w.boundKey}`)!.failure).toBe('host_lost');
    });

    it('a database blip while the host boots or serves does not cost the Run its host', async () => {
        const w = world();
        w.runEndsAt(w.clock.t + 30 * 60_000);
        for (const read of ['hostCell', 'liveClaimsOnHost', 'insertHost'] as const) {
            const original = (w.store[read] as (...a: unknown[]) => Promise<unknown>).bind(w.store);
            let blips = 1;
            (w.store as any)[read] = async (...a: unknown[]) => {
                if (blips-- > 0) throw new Error('connection terminated unexpectedly');
                return original(...a);
            };
        }
        expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'served' });
    });

    // v-core N9: the provider made the host, then the database failed to record it. The machine must still be destroyed.
    it('a database error right after the provider made the host never leaves the machine running', async () => {
        const w = world();
        w.runEndsAt(w.clock.t + 60_000);
        const moveHost = w.store.moveHost.bind(w.store);
        w.store.moveHost = async (...a: Parameters<typeof moveHost>) => {
            if (a[1] === 'provisioning') throw new Error('connection terminated unexpectedly');
            return moveHost(...a);
        };
        await runPerRunHost(w.input, w.deps).catch(() => undefined);
        const hosts = [...w.provider.hosts.values()];
        expect(hosts).toHaveLength(1);
        expect(hosts[0].state).toBe('gone');
    });

    describe('teardown', () => {
        it('a hub that cannot retire the cell does not keep the host alive: the host is destroyed, and the cell is retired once the hub answers again', async () => {
            const w = world();
            w.runEndsAt(w.clock.t + 60_000);
            // Longer than one retried step: the hub is down for a while.
            w.hub.failRetires = 20;
            const retire = w.hub.retire.bind(w.hub);
            let hostWhenRetired: string | undefined;
            w.hub.retire = async (id) => {
                await retire(id);
                hostWhenRetired = [...w.provider.hosts.values()][0].state;
            };
            expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'served' });
            // The machine did not wait for the hub.
            expect(hostWhenRetired).toBe('gone');
            expect(w.hub.retired).toEqual([w.hostId]);
            expect(w.store.hosts.get(w.hostId)!.state).toBe('terminated');
        });

        it('a provider that fails to destroy is asked again until it accepts; the row is terminated only after that', async () => {
            const w = world();
            w.runEndsAt(w.clock.t + 60_000);
            for (let i = 0; i < 12; i++) w.provider.failNext('destroy', new ProviderError('transient', 'http_503', { status: 503 }));
            expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'served' });
            expect(w.provider.calls.filter((c) => c.op === 'destroy').length).toBe(13);
            expect([...w.provider.hosts.values()][0].state).toBe('gone');
            expect(w.store.hosts.get(w.hostId)!.state).toBe('terminated');
        });

        it('a store that fails while the host failure is recorded still has the host destroyed and its cell retired', async () => {
            const w = world({ registersAfterMs: null });
            const failDemand = w.store.failDemand.bind(w.store);
            let broken = 10;
            w.store.failDemand = async (...a) => {
                if (broken-- > 0) throw new Error('connection terminated');
                return failDemand(...a);
            };
            await expect(runPerRunHost(w.input, w.deps)).rejects.toThrow('connection terminated');
            expect([...w.provider.hosts.values()][0].state).toBe('gone');
            expect(w.hub.retired).toEqual([w.hostId]);
            expect(w.store.hosts.get(w.hostId)!.state).toBe('terminated');
            // The other failure records still ran.
            expect(w.store.pools.get(w.poolId)!.status.consecutiveFailures).toBe(1);
        });

        it('a transient store error while the failure is recorded is retried, so the Run is still told why', async () => {
            const w = world({ registersAfterMs: null });
            const failDemand = w.store.failDemand.bind(w.store);
            let broken = 1;
            w.store.failDemand = async (...a) => {
                if (broken-- > 0) throw new Error('connection terminated');
                return failDemand(...a);
            };
            expect(await runPerRunHost(w.input, w.deps)).toEqual({ outcome: 'failed', failure: 'registration_timeout' });
            expect(w.store.demand.get(`${w.poolId}\n${w.boundKey}`)!.failure).toBe('registration_timeout');
        });

        it('a teardown that never succeeds gives up at its bound, marks the host failed, and ends the workflow in error', async () => {
            const w = world();
            w.runEndsAt(w.clock.t + 60_000);
            w.hub.failRetires = Number.POSITIVE_INFINITY;
            const before = w.clock.t;
            await expect(runPerRunHost(w.input, w.deps)).rejects.toThrow(/teardown/);
            // The host itself was destroyed; only the hub never answered.
            expect([...w.provider.hosts.values()][0].state).toBe('gone');
            expect(w.store.hosts.get(w.hostId)).toMatchObject({ state: 'failed', lastError: 'teardown_failed' });
            // It kept trying for at least a day: longer than any dead-man TTL and the cell's certificate.
            expect(w.clock.t - before).toBeGreaterThanOrEqual(24 * 3_600_000);
        });

        it('a process that dies during teardown resumes it and still ends with one host destroyed and the cell retired', async () => {
            const w = world();
            w.runEndsAt(w.clock.t + 60_000);
            w.hub.failRetires = 8;
            await runPerRunHost(w.input, w.deps);
            const total = w.steps.ran.length;
            for (let crashAt = total - 6; crashAt < total; crashAt++) {
                const v = world();
                v.runEndsAt(v.clock.t + 60_000);
                v.hub.failRetires = 8;
                v.steps.crashAfter = crashAt;
                void runPerRunHost(v.input, v.deps);
                await v.steps.crashed;
                expect(await runPerRunHost(v.input, v.deps)).toEqual({ outcome: 'served' });
                expect(v.hub.retired).toEqual([v.hostId]);
                expect(v.store.hosts.get(v.hostId)!.state).toBe('terminated');
            }
        });
    });
});
