import { CellUnavailableError, MemberCleanupPendingError } from '../../shared/errors';
import type { CellWant } from '../../shared/cell-directory';
import { claimIdFor } from '../../shared/claim-id';
import { devSealKey } from '../../testing/dev-seal-key';
import { hubEnvironments, poolCellOf } from '../dbos/run-deps.factory';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import { CellUnavailable, HubClaimReleaser, HubClient, HubEnvironmentClient, HubPoolTargetSender, HubRunEventSink, isNetworkError } from './hub-environment-runtime';

const secrets = new SealedSecretOpener(devSealKey());
const directory = (replica: string | null = 'https://hub-1') => ({
    reserveCell: async () => ({ cellId: 'cell-a', replicaUrl: 'https://hub-1', owner: 'kodus' as const }),
    replicaForClaim: async () => replica,
});
type Call = { url: string; headers: Record<string, string>; body: any };
const client = (post: (...a: any[]) => Promise<{ status: number; text: string }>, replica: string | null = 'https://hub-1') =>
    new HubClient({ cellDirectory: directory(replica), hubBaseUrl: 'https://hub', postImpl: post });
const recording = (calls: Call[], status = 200, text = '{}') => async (url: string, headers: Record<string, string>, body: string) => {
    calls.push({ url, headers, body: JSON.parse(body) });
    return { status, text };
};
const reset = () => Promise.reject(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
const runtime = (hub: HubClient, runId: string | null = 'run-1') =>
    new HubEnvironmentClient(hub, secrets, {
        correlationId: 'corr',
        organizationId: 'org-a',
        ...(runId ? { runId } : {}),
        repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' } as any,
        sealedRepoToken: secrets.seal('ghs_plain', runId ?? 'setup-key'),
        tokenBinding: runId ?? 'setup-key',
        imageId: 'img',
        expose: [],
    });

// A hub replica restarting (a deploy) drops the worker's connections: the
// calls of a live Run must come back as "cell unavailable" (a lost round the
// gate already handles), never as an exception that ends the Run errored.
describe('HubClient when the hub drops or is restarting', () => {
    it('decodes only the strict structured cleanup code on HTTP 503, preserving rolling fail-closed behavior', async () => {
        const pending = JSON.stringify({ code: 'member_cleanup_pending', message: 'member_cleanup_pending' });
        await expect(client(recording([], 503, pending)).post('https://hub', '/cancel', {})).rejects.toBeInstanceOf(MemberCleanupPendingError);
        for (const body of ['member_cleanup_pending', JSON.stringify({ code: 'cell_unavailable', message: 'member_cleanup_pending' }), JSON.stringify({ code: 'member_cleanup_pending', message: 'secret', extra: true }), '{bad']) {
            const error = await client(recording([], 503, body)).post('https://hub', '/cancel', {}).catch(e => e);
            expect(error).toBeInstanceOf(CellUnavailableError);
            expect(error).not.toBeInstanceOf(MemberCleanupPendingError);
        }
    });

    it('tells a dropped connection from an answer', () => {
        expect(isNetworkError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
        expect(isNetworkError(new Error('socket hang up'))).toBe(true);
        expect(isNetworkError(new Error('hub /x answered 500'))).toBe(false);
    });

    it('a reset connection or a 502 from the load balancer is CellUnavailable', async () => {
        await expect(client(reset).post('https://hub-1', '/x', {})).rejects.toBeInstanceOf(CellUnavailable);
        await expect(client(async () => ({ status: 502, text: 'bad gateway' })).post('https://hub-1', '/x', {})).rejects.toBeInstanceOf(CellUnavailable);
        await expect(client(async () => ({ status: 500, text: 'boom' })).post('https://hub-1', '/x', {})).rejects.not.toBeInstanceOf(CellUnavailable);
    });

    it('an answer that is not a JSON object is an error, not a value', async () => {
        await expect(client(async () => ({ status: 200, text: 'null' })).post('https://hub-1', '/x', {})).rejects.toThrow(/non-object/);
        await expect(client(async () => ({ status: 200, text: '<html>' })).post('https://hub-1', '/x', {})).rejects.toThrow(/not JSON/);
    });

    it('a probe, an exec or a reset during a hub restart is a lost call, not a thrown error', async () => {
        const env = runtime(client(reset));
        await expect(env.probe('c1', { id: 'p', spec: { timeoutMs: 1_000 } } as any, 's1')).resolves.toEqual({ code: 'cell_unavailable', cellId: 'unknown' });
        await expect(env.exec('c1', { stepId: 's2', command: 'ls', timeoutMs: 1_000 } as any)).resolves.toEqual({ code: 'cell_unavailable', cellId: 'unknown' });
        await expect(env.reset('c1')).resolves.toEqual({ code: 'cell_unavailable', cellId: 'unknown' });
    });
});

describe('HubEnvironmentClient', () => {
    it('uses the configured image for callers that do not supply a reset pin', async () => {
        const calls: Call[] = [];
        await runtime(client(recording(calls, 200, '{"ok":true}'))).reset('c1');
        expect(calls[0].body).toMatchObject({ organizationId: 'org-a', runId: 'run-1', imageId: 'img' });
    });

    // A reconstructed workflow client has no acquire-time cache; its durable claim pin must travel explicitly.
    it('uses the explicit durable pin on a freshly constructed client without acquiring again', async () => {
        const calls: Call[] = [];
        const env = runtime(client(recording(calls, 200, '{"ok":true}')));
        const resetWithPin = env.reset as (claimId: string, imageId?: string) => ReturnType<typeof env.reset>;
        await resetWithPin.call(env, 'c1', 'bake-concrete');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ url: 'https://hub-1/internal/claims/c1/reset', body: { organizationId: 'org-a', runId: 'run-1', imageId: 'bake-concrete' } });
    });

    it('opens the sealed repo token only for the acquire call, and sends it to the replica of the reserved cell', async () => {
        const calls: Call[] = [];
        await runtime(client(recording(calls))).acquire({ organizationId: 'org-a', runId: 'run-1', ref: { side: 'base', sha: 'a'.repeat(40) } } as any);
        expect(calls[0].url).toBe('https://hub-1/internal/cells/cell-a/acquire');
        expect(calls[0].body.repoToken).toBe('ghs_plain');
    });

    it('each side fetches with its own token: the PR claim never gets the one the base claim revokes', async () => {
        const calls: Call[] = [];
        const env = new HubEnvironmentClient(client(recording(calls)), secrets, {
            correlationId: 'corr',
            organizationId: 'org-a',
            runId: 'run-1',
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' } as any,
            sealedRepoToken: secrets.seal('ghs_base', 'run-1'),
            sealedPrRepoToken: secrets.seal('ghs_pr', 'run-1'),
            tokenBinding: 'run-1',
            imageId: 'img',
            expose: [],
        });
        await env.acquire({ organizationId: 'org-a', runId: 'run-1', ref: { side: 'base', sha: 'a'.repeat(40) } } as any);
        await env.acquire({ organizationId: 'org-a', runId: 'run-1', ref: { side: 'pr', sha: 'b'.repeat(40) } } as any);
        expect(calls.map((c) => c.body.repoToken)).toEqual(['ghs_base', 'ghs_pr']);
        // An older product sent one token: both sides use it.
        const one: Call[] = [];
        await runtime(client(recording(one))).acquire({ organizationId: 'org-a', runId: 'run-1', ref: { side: 'pr', sha: 'b'.repeat(40) } } as any);
        expect(one[0].body.repoToken).toBe('ghs_plain');
    });

    it('the production factory keeps the PR token too: it was dropped there, so the PR fetched with the base token', async () => {
        const calls: Call[] = [];
        const env = hubEnvironments(client(recording(calls)), secrets, { provider: 'github', apiBase: 'https://api.github.com' })({
            correlationId: 'corr',
            organizationId: 'org-a',
            runId: 'run-1',
            fullName: 'acme/shop',
            sealedRepoToken: secrets.seal('ghs_base', 'run-1'),
            sealedPrRepoToken: secrets.seal('ghs_pr', 'run-1'),
            tokenBinding: 'run-1',
            imageId: 'img',
            expose: [],
        });
        await env.acquire({ organizationId: 'org-a', runId: 'run-1', ref: { side: 'pr', sha: 'b'.repeat(40) } } as any);
        expect(calls[0].body.repoToken).toBe('ghs_pr');
    });

    it('a token sealed for another Run does not open: nothing is sent', async () => {
        const calls: Call[] = [];
        const env = new HubEnvironmentClient(client(recording(calls)), secrets, {
            correlationId: 'c',
            organizationId: 'org-a',
            runId: 'run-1',
            repo: {} as any,
            sealedRepoToken: secrets.seal('ghs_plain', 'run-2'),
            tokenBinding: 'run-1',
            imageId: 'img',
            expose: [],
        });
        await expect(env.acquire({ organizationId: 'org-a' } as any)).rejects.toThrow(/sealed secret/);
        expect(calls).toHaveLength(0);
    });

    it('every claim call names its tenant: the org and the Run (null for a setup)', async () => {
        const calls: Call[] = [];
        await runtime(client(recording(calls))).probe('c1', { id: 'p', spec: { timeoutMs: 1_000 } } as any, 's1');
        await runtime(client(recording(calls)), null).release('c2');
        expect(calls[0].body).toMatchObject({ organizationId: 'org-a', runId: 'run-1', stepId: 's1' });
        expect(calls[1].body).toEqual({ organizationId: 'org-a', runId: null });
    });

    it('a renew goes to the replica that holds the claim, with the tenant and the consumer; a lost hub is cell_unavailable', async () => {
        const calls: Call[] = [];
        const answer = JSON.stringify({ status: 'renewed', leaseExpiresAt: '2026-11-06T11:00:00.000Z', hardExpiresAt: '2026-11-06T11:00:00.000Z', atCeiling: true });
        await expect(runtime(client(recording(calls, 200, answer))).renew('c1', 'runtime')).resolves.toMatchObject({ status: 'renewed', atCeiling: true });
        expect(calls[0]).toMatchObject({ url: 'https://hub-1/internal/claims/c1/renew', body: { organizationId: 'org-a', runId: 'run-1', consumer: 'runtime' } });
        await expect(runtime(client(reset)).renew('c1', 'runtime')).resolves.toEqual({ code: 'cell_unavailable', cellId: 'unknown' });
        await expect(runtime(client(recording([]), null)).renew('c1', 'runtime')).resolves.toEqual({ code: 'cell_unavailable', cellId: 'unknown' });
    });

    it('a release with no replica holding the cell goes to any hub, which records it', async () => {
        const calls: Call[] = [];
        await new HubClaimReleaser(client(recording(calls), null)).release({ claimId: 'c9', organizationId: 'org-a', runId: 'r' });
        expect(calls[0].url).toBe('https://hub/internal/claims/c9/release');
    });
});

describe('HubRunEventSink', () => {
    it('sends the event key, retries a hub outage, and drops the event (counted) instead of failing the Run', async () => {
        const calls: Call[] = [];
        const ok = new HubRunEventSink(client(recording(calls)), undefined, []);
        await ok.append('org-a', 'run-1', { type: 'state', at: 'now', data: {} }, '1:state:booting');
        expect(calls[0].body).toMatchObject({ organizationId: 'org-a', key: '1:state:booting' });

        let tries = 0;
        const dropped: string[] = [];
        const down = new HubRunEventSink(
            client(() => (tries++, reset())),
            (_e, event) => void dropped.push(event.type),
            [0, 0],
        );
        await expect(down.append('org-a', 'run-1', { type: 'phase', at: 'now', data: {} })).resolves.toBeUndefined();
        expect(tries).toBe(3);
        expect(dropped).toEqual(['phase']);
    });
});

// pool.target after a setup goes to the cell that baked, through the replica
// holding the setup claim, as `latest` and naming no claim (the hub refuses a
// pool tied to a claim, S-52); an admin's change goes through the replica
// that holds the cell.
describe('pool.target', () => {
    it('after the bake: the setup claim finds the replica, the body names no claim', async () => {
        const calls: Call[] = [];
        const env = runtime(client(recording(calls, 200, '{"status":"accepted"}')), null);
        const out = await env.poolTarget({ organizationId: 'org-a', environmentId: 'env-1', size: 2, cellId: 'cell-a', claimId: 'claim-setup' });
        expect(out).toEqual({ status: 'accepted' });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://hub-1/internal/cells/cell-a/pool-target');
        expect(calls[0].body).toEqual({ organizationId: 'org-a', environmentId: 'env-1', imageId: 'latest', size: 2 });
    });

    it("carries the environment's machine size, from the setup and from an admin's change", async () => {
        const big = { memoryMb: 16_384, cpus: 8 };
        const calls: Call[] = [];
        await runtime(client(recording(calls, 200, '{"status":"accepted"}')), null).poolTarget({ organizationId: 'org-a', environmentId: 'env-1', size: 2, machineSize: big, cellId: 'cell-a', claimId: 'c' });
        await new HubPoolTargetSender(client(recording(calls, 200, '{"status":"accepted"}')), async () => 'https://hub-2').send({ organizationId: 'org-a', environmentId: 'env-1', size: 3, machineSize: big, cellId: 'cell-a' });
        expect(calls.map((c) => c.body)).toEqual([
            { organizationId: 'org-a', environmentId: 'env-1', imageId: 'latest', size: 2, machineSize: big },
            { organizationId: 'org-a', environmentId: 'env-1', imageId: 'latest', size: 3, machineSize: big },
        ]);
    });

    it('a refusal is an outcome, not an exception; an admin change with no replica for the cell is refused', async () => {
        const calls: Call[] = [];
        const env = runtime(client(recording(calls, 409, '{"status":"refused","code":"pool_unsupported","message":"no pool"}')), null);
        expect(await env.poolTarget({ organizationId: 'org-a', environmentId: 'env-1', size: 1, cellId: 'cell-a', claimId: 'c' })).toMatchObject({ status: 'refused', code: 'pool_unsupported' });

        const sent: Call[] = [];
        const sender = new HubPoolTargetSender(client(recording(sent, 200, '{"status":"accepted"}')), async (cell) => (cell === 'cell-a' ? 'https://hub-2' : null));
        expect(await sender.send({ organizationId: 'org-a', environmentId: 'env-1', size: 3, cellId: 'cell-a' })).toEqual({ status: 'accepted' });
        expect(sent[0].url).toBe('https://hub-2/internal/cells/cell-a/pool-target');
        expect(await sender.send({ organizationId: 'org-a', environmentId: 'env-1', size: 3, cellId: 'cell-gone' })).toMatchObject({ status: 'refused', code: 'cell_unavailable' });
        expect(sent).toHaveLength(1);
    });
});

// The claim of an environment goes first to the cell holding its warm pool;
// a failure finding that cell is no preference, never a failed acquire.
describe('acquire prefers the pool cell', () => {
    const acquireReq = { organizationId: 'org-a', environmentId: 'env-1' } as any;
    const directoryAsked = () => {
        const asked: Array<string | undefined> = [];
        const hub = new HubClient({
            cellDirectory: { reserveCell: async (_o: string, want?: CellWant) => (asked.push(want?.prefer), null), replicaForClaim: async () => null },
            hubBaseUrl: 'https://hub',
            postImpl: async () => ({ status: 200, text: '{}' }),
        });
        return { asked, hub };
    };
    const client = (hub: HubClient, preferCell?: (o: string, e: string) => Promise<string | undefined>) =>
        new HubEnvironmentClient(hub, secrets, {
            correlationId: 'corr', organizationId: 'org-a', repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' } as any,
            sealedRepoToken: secrets.seal('ghs_plain', 'setup-key'), tokenBinding: 'setup-key', imageId: 'img', expose: [],
            ...(preferCell ? { preferCell } : {}),
        });

    it('asks the directory for the pool cell first, and for none when finding it fails', async () => {
        const { asked, hub } = directoryAsked();
        await expect(client(hub, async (o, e) => (o === 'org-a' && e === 'env-1' ? 'cell-pool' : undefined)).acquire(acquireReq)).rejects.toThrow();
        await expect(client(hub, async () => Promise.reject(new Error('mongo down'))).acquire(acquireReq)).rejects.toThrow();
        await expect(client(hub).acquire(acquireReq)).rejects.toThrow();
        expect(asked).toEqual(['cell-pool', undefined, undefined]);
    });

    it("takes the pool cell only from a setup record of the same org", async () => {
        const of = poolCellOf({ get: async (env: string) => (env === 'env-1' ? { organizationId: 'org-a', cellId: 'cell-pool' } : null) });
        expect(await of('org-a', 'env-1')).toBe('cell-pool');
        expect(await of('org-b', 'env-1')).toBeUndefined();
        expect(await of('org-a', 'env-2')).toBeUndefined();
    });

    it('prefers the cell the last failed boot built on when no setup is active', async () => {
        const recs: Record<string, { organizationId: string; cellId?: string; buildCellId?: string }> = {
            'env-built': { organizationId: 'org-a', buildCellId: 'cell-state' },
            'env-both': { organizationId: 'org-a', cellId: 'cell-pool', buildCellId: 'cell-state' },
        };
        const of = poolCellOf({ get: async (env: string) => recs[env] ?? null });
        expect(await of('org-a', 'env-built')).toBe('cell-state');
        expect(await of('org-a', 'env-both')).toBe('cell-pool');
        expect(await of('org-b', 'env-built')).toBeUndefined();
    });
});

// Cells connected but none may take the claim now: a blocked acquire with its
// card's signature, sent to no cell, never a full cell or a thrown error.
describe('acquire when no cell may take the claim', () => {
    const acquireReq = { organizationId: 'org-a', environmentId: 'env-1', idempotencyKey: 'run-1:pr:1' } as any;
    const blockedBy = (answer: unknown) => {
        const asked: Array<string | undefined> = [];
        const wanted: Array<CellWant | undefined> = [];
        const posted: string[] = [];
        const hub = new HubClient({
            cellDirectory: { reserveCell: async (_o: string, want?: CellWant) => (asked.push(want?.claimId), wanted.push(want), answer as any), replicaForClaim: async () => null },
            hubBaseUrl: 'https://hub',
            postImpl: async (url) => (posted.push(url), { status: 200, text: '{}' }),
        });
        return { asked, wanted, posted, env: runtime(hub) };
    };

    it("the org's cap on shared cells is blocked org_capacity, naming the cap", async () => {
        const { asked, posted, env } = blockedBy({ refused: 'org_capacity', cap: 8, open: 8 });
        const r = await env.acquire(acquireReq);
        expect(r).toMatchObject({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'org_capacity' }] });
        expect((r as any).blockers[0].message).toContain('cap 8');
        expect(posted).toEqual([]);
        // The claim being acquired is named, so its own new round never counts against the cap.
        expect(asked).toEqual([claimIdFor('org-a', 'run-1:pr:1')]);
    });

    it('every eligible cell full is blocked no_capacity; no cell connected is still CellUnavailable', async () => {
        const full = blockedBy({ refused: 'no_capacity' });
        expect(await full.env.acquire(acquireReq)).toMatchObject({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'no_capacity' }] });
        expect(full.posted).toEqual([]);
        await expect(blockedBy(null).env.acquire(acquireReq)).rejects.toBeInstanceOf(CellUnavailable);
    });

    it('asks the directory for a cell that grants the size the claim will ask, and none for an unsized claim', async () => {
        const sized = blockedBy({ refused: 'no_capacity' });
        await sized.env.acquire({ ...acquireReq, size: { memoryMb: 16_384, cpus: 8 } });
        expect(sized.wanted[0]).toMatchObject({ size: { memoryMb: 16_384, cpus: 8 } });
        const plain = blockedBy({ refused: 'no_capacity' });
        await plain.env.acquire(acquireReq);
        expect(plain.wanted[0]).not.toHaveProperty('size');
    });

    it('no connected cell granting the size is blocked size_unavailable, naming what was asked and the largest grant', async () => {
        const size = { memoryMb: 16_384, cpus: 8 };
        const smaller = blockedBy({ refused: 'size_unavailable', size, largest: { memoryMb: 8_192, cpus: 4 } });
        const r = (await smaller.env.acquire({ ...acquireReq, size })) as any;
        expect(r).toMatchObject({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'size_unavailable' }] });
        expect(r.blockers[0].message).toBe(
            'asked 16384 MB / 8 CPUs, and no connected cell that may serve this organization grants it: the largest any of them grants is 8192 MB / 4 CPUs; the claim was not started',
        );
        expect(smaller.posted).toEqual([]);
        const none = (await blockedBy({ refused: 'size_unavailable', size, largest: null }).env.acquire({ ...acquireReq, size })) as any;
        expect(none.blockers[0].message).toContain('none of them grants a machine size');
    });
});

describe('HubEnvironmentClient local browser exploration', () => {
    const request = { steps: [{ goto: '/' }], viewport: { width: 800, height: 600 }, timeoutMs: 1000 };
    const result = { status: 'observed', snapshot: 'button', candidates: [], actionsCompleted: 1, durationMs: 1, cliCalls: 2, truncated: false };
    it('waits past the runner startup/cleanup and hub deadlines', async () => {
        const post = jest.fn(async (..._args: unknown[]) => ({ status: 200, text: JSON.stringify(result) }));
        await runtime(client(post)).exploreBrowser('c1', request, 's1');
        expect(post.mock.calls[0][3]).toBe(request.timeoutMs + 40_000);
    });
    it('uses the owning replica and tenant, validates the result and treats a restart as unavailable transport', async () => {
        const calls: Call[] = [];
        expect(await runtime(client(recording(calls, 200, JSON.stringify(result)))).exploreBrowser('c1', request, 's1')).toEqual(result);
        expect(calls[0]).toMatchObject({ url: 'https://hub-1/internal/claims/c1/browser-explore', body: { organizationId: 'org-a', runId: 'run-1', stepId: 's1', request } });
        expect(await runtime(client(recording([], 200, '{}'))).exploreBrowser('c1', request, 's2')).toMatchObject({ status: 'unavailable' });
        expect(await runtime(client(reset)).exploreBrowser('c1', request, 's3')).toMatchObject({ code: 'cell_unavailable' });
    });
});
