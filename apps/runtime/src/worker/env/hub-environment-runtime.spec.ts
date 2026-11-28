import { CellUnavailableError, MemberCleanupPendingError } from '../../shared/errors';
import type { CellWant } from '../../shared/persistence/cell-directory';
import { claimIdFor } from '../../shared/claim-id';
import { devSealKey } from '../../testing/dev-seal-key';
import { hubEnvironments, poolCellOf } from '../dbos/run-deps.factory';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import { HubClaimReleaser, HubClient, HubEnvironmentClient, HubPoolTargetSender, HubRequestTimeoutError, HubRunEventSink, isNetworkError, mtlsPost } from './hub-environment-runtime';
import { createServer } from 'node:http';
import { BROWSER_ROUND_GRACE_MS, verifyEvidenceSignature } from '@libs/runtime/contracts/evidence';
import type { EvidenceUploads } from '../run/run-evidence';
import type { AddressInfo } from 'node:net';

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
const runtime = (hub: HubClient, runId: string | null = 'run-1', evidenceReads?: EvidenceUploads, isolationMinimum?: 'any' | 'kernel' | 'vm') =>
    new HubEnvironmentClient(hub, secrets, {
        ...(evidenceReads ? { evidenceReads } : {}),
        ...(isolationMinimum ? { isolationMinimum } : {}),
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
        expect(isNetworkError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(true);
        expect(isNetworkError(new HubRequestTimeoutError())).toBe(true);
        expect(isNetworkError(new Error('hub /x answered 500'))).toBe(false);
    });

    it('does not read a network failure from the words of a message without a code', () => {
        expect(isNetworkError(new Error('socket hang up'))).toBe(false);
        expect(isNetworkError(new Error('hub request timed out'))).toBe(false);
    });

    it('reports a hub that never answers as a request timeout', async () => {
        const server = createServer(() => undefined);
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
        const { port } = server.address() as AddressInfo;
        const error = await mtlsPost(undefined)(`http://127.0.0.1:${port}/x`, {}, '{}', 50).catch((e) => e);
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        expect(error).toBeInstanceOf(HubRequestTimeoutError);
        expect(isNetworkError(error)).toBe(true);
    });

    it('sends again a call the hub refused at connect (a replica restarting), and only that', async () => {
        const refused = () => Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
        const slept: number[] = [];
        const sleep = async (ms: number) => void slept.push(ms);
        let calls = 0;
        const flaky = async () => (++calls < 3 ? refused() : { status: 200, text: '{"ok":true}' });
        const hub = new HubClient({ cellDirectory: directory(), hubBaseUrl: 'https://hub', postImpl: flaky, refusedRetryDelaysMs: [1, 2, 3], sleep });
        await expect(hub.post('https://hub-1', '/x', {})).resolves.toEqual({ ok: true });
        expect(slept).toEqual([1, 2]);
        const down = new HubClient({ cellDirectory: directory(), hubBaseUrl: 'https://hub', postImpl: refused, refusedRetryDelaysMs: [1], sleep });
        await expect(down.post('https://hub-1', '/x', {})).rejects.toBeInstanceOf(CellUnavailableError);
        // A reset may have reached the hub: never sent twice.
        let resets = 0;
        const once = new HubClient({ cellDirectory: directory(), hubBaseUrl: 'https://hub', postImpl: () => (resets++, reset()), refusedRetryDelaysMs: [1, 2], sleep });
        await expect(once.post('https://hub-1', '/x', {})).rejects.toBeInstanceOf(CellUnavailableError);
        expect(resets).toBe(1);
    });

    it('a reset connection or a 502 from the load balancer is CellUnavailableError', async () => {
        await expect(client(reset).post('https://hub-1', '/x', {})).rejects.toBeInstanceOf(CellUnavailableError);
        await expect(client(async () => ({ status: 502, text: 'bad gateway' })).post('https://hub-1', '/x', {})).rejects.toBeInstanceOf(CellUnavailableError);
        await expect(client(async () => ({ status: 500, text: 'boom' })).post('https://hub-1', '/x', {})).rejects.not.toBeInstanceOf(CellUnavailableError);
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

    it("gives a reset the Run's reset deadline and waits the hub's answer past it; without one, the default", async () => {
        const waits: number[] = [];
        const calls: Call[] = [];
        const post = async (url: string, headers: Record<string, string>, body: string, timeoutMs: number) => {
            waits.push(timeoutMs);
            return recording(calls, 200, '{"ok":true}')(url, headers, body);
        };
        const sized = new HubEnvironmentClient(client(post), secrets, {
            correlationId: 'corr', organizationId: 'org-a', runId: 'run-1',
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' } as any,
            sealedRepoToken: secrets.seal('ghs_plain', 'run-1'), tokenBinding: 'run-1', imageId: 'img', expose: [],
            resetTimeoutMs: 900_000,
        });
        await sized.reset('c1');
        await runtime(client(post)).reset('c1');
        expect(calls[0].body).toMatchObject({ imageId: 'img', timeoutMs: 900_000 });
        expect(waits[0]).toBeGreaterThan(900_000);
        expect(calls[1].body).not.toHaveProperty('timeoutMs');
        expect(waits[1]).toBeGreaterThan(120_000);
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

    it("a suite shard's acquire names the suite run and shard to the placement, and neither goes to the cell", async () => {
        const calls: Call[] = [];
        const asked: Array<CellWant | undefined> = [];
        const hub = new HubClient({ cellDirectory: { reserveCell: async (_o: string, want?: CellWant) => (asked.push(want), { cellId: 'cell-a', replicaUrl: 'https://hub-1', owner: 'kodus' as const }), replicaForClaim: async () => 'https://hub-1' }, hubBaseUrl: 'https://hub', postImpl: recording(calls) });
        await runtime(hub, 'sr-1').acquire({ organizationId: 'org-a', consumer: 'suite', suiteRunId: 'sr-1', shard: 2, ref: { side: 'pr', sha: 'b'.repeat(40) } } as any);
        expect(asked[0]).toMatchObject({ consumer: 'suite', suiteRunId: 'sr-1', shard: 2 });
        expect(calls[0].body).not.toHaveProperty('shard');
        expect(calls[0].body).not.toHaveProperty('suiteRunId');
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

    it("an upload carries a read grant per file of the Run's org to the claim's replica; a cell that cannot take files is upload_unavailable", async () => {
        const reads = { baseUrl: 'https://evidence.cell', secret: 's'.repeat(32), now: () => new Date('2026-11-16T00:00:00Z') };
        const ref = 'org-a/run-1/base/0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d/output';
        const calls: Call[] = [];
        const files = [{ path: 'fixtures/a.json', contentRef: ref, mode: 0o644 }];
        expect(await runtime(client(recording(calls, 200, '{"ok":true}')), 'run-1', reads).upload('c1', { stepId: 's1', files })).toBeUndefined();
        expect(calls[0].url).toBe('https://hub-1/internal/claims/c1/upload');
        const sent = calls[0].body as { files: Array<{ url: string }> };
        expect(sent).toEqual({ organizationId: 'org-a', runId: 'run-1', stepId: 's1', files: [{ ...files[0], url: expect.any(String) }] });
        const url = new URL(sent.files[0].url);
        expect(url.origin + url.pathname).toBe(`https://evidence.cell/${ref}`);
        expect(verifyEvidenceSignature({ key: ref, exp: Number(url.searchParams.get('exp')), sig: url.searchParams.get('sig')!, secret: reads.secret, now: reads.now() })).toBe(true);
        expect(await runtime(client(recording([], 200, '{"code":"upload_unavailable"}')), 'run-1', reads).upload('c1', { stepId: 's2', files })).toEqual({ code: 'upload_unavailable' });
        expect(await runtime(client(recording([]), null), 'run-1', reads).upload('c1', { stepId: 's3', files })).toEqual({ code: 'cell_unavailable', cellId: 'unknown' });
    });

    it('an upload of another org\'s object, of a ref that is not an evidence key, or with no evidence store to read from never reaches the hub', async () => {
        const reads = { baseUrl: 'https://evidence.cell', secret: 's'.repeat(32) };
        const calls: Call[] = [];
        const step = '0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d';
        expect(await runtime(client(recording(calls)), 'run-1', reads).upload('c1', { stepId: 's1', files: [{ path: 'a', contentRef: `org-b/run-1/base/${step}/output` }] })).toEqual({ code: 'upload_failed', stepId: 's1', reason: 'files[0].contentRef is not an object of this org' });
        expect(await runtime(client(recording(calls)), 'run-1', reads).upload('c1', { stepId: 's2', files: [{ path: 'a', contentRef: 'ref-1' }] })).toEqual({ code: 'upload_failed', stepId: 's2', reason: 'files[0].contentRef is not an object of this org' });
        expect(await runtime(client(recording(calls))).upload('c1', { stepId: 's3', files: [{ path: 'a', contentRef: `org-a/run-1/base/${step}/output` }] })).toEqual({ code: 'upload_unavailable' });
        expect(calls).toHaveLength(0);
    });

    it("status reads the health of an environment of the Run's own org only, from the health reader it was given", async () => {
        const asked: string[][] = [];
        const env = new HubEnvironmentClient(client(recording([])), secrets, {
            correlationId: 'corr',
            organizationId: 'org-a',
            repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' } as any,
            sealedRepoToken: secrets.seal('ghs_plain', 'k'),
            tokenBinding: 'k',
            imageId: 'img',
            expose: [],
            health: async (org, id) => {
                asked.push([org, id]);
                return { environmentId: id, state: 'active', boots7d: 3, bootRate7d: 1, blockers: [] };
            },
        });
        expect(await env.status({ organizationId: 'org-a', environmentId: 'env-1' })).toMatchObject({ state: 'active', boots7d: 3 });
        expect(await env.status({ organizationId: 'org-b', environmentId: 'env-1' })).toEqual({ environmentId: 'env-1', state: 'not_set_up', boots7d: 0, blockers: [] });
        expect(await runtime(client(recording([]))).status({ organizationId: 'org-a', environmentId: 'env-2' })).toEqual({ environmentId: 'env-2', state: 'not_set_up', boots7d: 0, blockers: [] });
        expect(asked).toEqual([['org-a', 'env-1']]);
    });

    it('the production factory reads health from the setup record of the same org', async () => {
        const rec = { organizationId: 'org-a', environmentId: 'env-1', state: 'active', imageId: 'img-1', blockers: [], boots: [] };
        const make = hubEnvironments(client(recording([])), secrets, { provider: 'github', apiBase: 'https://api.github.com' } as any, undefined, { get: async () => rec as any });
        const env = make({ correlationId: 'c', organizationId: 'org-a', fullName: 'acme/shop', sealedRepoToken: secrets.seal('t', 'k'), tokenBinding: 'k', imageId: 'img', expose: [] } as any);
        expect(await env.status!({ organizationId: 'org-a', environmentId: 'env-1' })).toMatchObject({ state: 'active', imageId: 'img-1' });
        const other = make({ correlationId: 'c', organizationId: 'org-b', fullName: 'acme/shop', sealedRepoToken: secrets.seal('t', 'k'), tokenBinding: 'k', imageId: 'img', expose: [] } as any);
        expect(await other.status!({ organizationId: 'org-b', environmentId: 'env-1' })).toMatchObject({ state: 'not_set_up' });
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
        await expect(client(hub, async () => Promise.reject(new Error('database down'))).acquire(acquireReq)).rejects.toThrow();
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

// A template's setup is placed on the cell bound to its key (host-providers.md §8.2): the key reaches the
// directory, and never the cell or the hub, whose acquire body does not know it.
describe("acquire of a template's setup", () => {
    const key = 'template:org-a/env-1';
    const run = async (req: Record<string, unknown>) => {
        const wanted: Array<CellWant | undefined> = [];
        const bodies: any[] = [];
        const hub = new HubClient({
            cellDirectory: { reserveCell: async (_o: string, want?: CellWant) => (wanted.push(want), { cellId: 'cell-a', replicaUrl: 'https://hub-1', owner: 'kodus' as const }), replicaForClaim: async () => null },
            hubBaseUrl: 'https://hub',
            postImpl: async (_u, _h, body) => (bodies.push(JSON.parse(body)), { status: 200, text: '{}' }),
        });
        await runtime(hub, null).acquire({ organizationId: 'org-a', environmentId: 'env-1', idempotencyKey: 'setup:s-1', ref: { side: 'setup', sha: 'a'.repeat(40) }, ...req } as any).catch(() => undefined);
        return { wanted, bodies };
    };

    it('asks the directory for the key and sends the hub an acquire without it', async () => {
        const { wanted, bodies } = await run({ consumer: 'setup', boundKey: key });
        expect(wanted[0]).toMatchObject({ consumer: 'setup', boundKey: key });
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).not.toHaveProperty('boundKey');
    });

    it('never carries a key for a claim that is not a setup', async () => {
        const { wanted } = await run({ consumer: 'runtime', runId: 'run-1', boundKey: key });
        expect(wanted[0]).not.toHaveProperty('boundKey');
    });
});

// A host bound to one claim alone is paid whole: the claim asks all it grants, not the environment's size.
describe('acquire on a host of its own', () => {
    const max = { memoryMb: 14_966, cpus: 8 };
    const medium = { memoryMb: 8_192, cpus: 4 };
    const run = async (req: Record<string, unknown>, cell: Record<string, unknown>) => {
        const bodies: any[] = [];
        const hub = new HubClient({
            cellDirectory: { reserveCell: async () => ({ cellId: 'cell-a', replicaUrl: 'https://hub-1', owner: 'kodus' as const, ...cell }), replicaForClaim: async () => null },
            hubBaseUrl: 'https://hub',
            postImpl: async (_u, _h, body) => (bodies.push(JSON.parse(body)), { status: 200, text: '{}' }),
        });
        await runtime(hub, (req.runId as string) ?? null).acquire({ organizationId: 'org-a', environmentId: 'env-1', size: medium, ...req } as any).catch(() => undefined);
        return bodies[0];
    };
    const shard = { consumer: 'suite', suiteRunId: 'sr-1', shard: 2, idempotencyKey: 'suite:sr-1:2', ref: { side: 'suite', sha: 'a'.repeat(40) } };
    const prSide = { consumer: 'runtime', runId: 'run-1', idempotencyKey: 'run-1:pr:1', ref: { side: 'pr', sha: 'a'.repeat(40) } };

    it("a suite shard on the host bound to that shard asks everything the host grants", async () => {
        expect((await run(shard, { boundKey: 'suite:org-a/sr-1/2', maxClaimSize: max })).size).toEqual(max);
    });

    it("one side of a Run split across hosts, on that side's host, asks everything the host grants", async () => {
        expect((await run(prSide, { boundKey: 'run:org-a/run-1/pr', maxClaimSize: max })).size).toEqual(max);
    });

    it("keeps the environment's size on a host it shares: both sides on one Run host, a shared cell, or another claim's host", async () => {
        expect((await run(prSide, { boundKey: 'run:org-a/run-1', maxClaimSize: max })).size).toEqual(medium);
        expect((await run(shard, { boundKey: null, maxClaimSize: max })).size).toEqual(medium);
        expect((await run(shard, { boundKey: 'suite:org-a/sr-1/1', maxClaimSize: max })).size).toEqual(medium);
    });

    it('never asks less than the environment asked, and keeps it when the host names no grant', async () => {
        const large = { memoryMb: 16_384, cpus: 8 };
        expect((await run({ ...shard, size: large }, { boundKey: 'suite:org-a/sr-1/2', maxClaimSize: max })).size).toEqual({ memoryMb: 16_384, cpus: 8 });
        expect((await run(shard, { boundKey: 'suite:org-a/sr-1/2', maxClaimSize: null })).size).toEqual(medium);
    });
});

// Cells connected but none may take the claim now: a blocked acquire with its
// card's signature, sent to no cell, never a full cell or a thrown error.
describe('acquire when no cell may take the claim', () => {
    const acquireReq = { organizationId: 'org-a', environmentId: 'env-1', idempotencyKey: 'run-1:pr:1' } as any;
    const blockedBy = (answer: unknown, isolationMinimum?: 'any' | 'kernel' | 'vm') => {
        const asked: Array<string | undefined> = [];
        const wanted: Array<CellWant | undefined> = [];
        const posted: string[] = [];
        const hub = new HubClient({
            cellDirectory: { reserveCell: async (_o: string, want?: CellWant) => (asked.push(want?.claimId), wanted.push(want), answer as any), replicaForClaim: async () => null },
            hubBaseUrl: 'https://hub',
            postImpl: async (url) => (posted.push(url), { status: 200, text: '{}' }),
        });
        return { asked, wanted, posted, env: runtime(hub, 'run-1', undefined, isolationMinimum) };
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

    it('every eligible cell full is blocked no_capacity; no cell connected is NoCellConnectedError (a CellUnavailableError)', async () => {
        const full = blockedBy({ refused: 'no_capacity' });
        expect(await full.env.acquire(acquireReq)).toMatchObject({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'no_capacity' }] });
        expect(full.posted).toEqual([]);
        await expect(blockedBy(null).env.acquire(acquireReq)).rejects.toBeInstanceOf(CellUnavailableError);
    });

    it('a wait for room carries how many hosts are full and when the first frees at the latest, or the cap and when the org frees one', async () => {
        const full = await blockedBy({ refused: 'no_capacity', hosts: 2, nextFreeAt: '2026-11-17T12:04:00.000Z' }).env.acquire(acquireReq);
        expect(full).toMatchObject({ status: 'blocked', blockers: [{ signature: 'no_capacity' }], capacity: { hosts: 2, nextFreeAt: '2026-11-17T12:04:00.000Z' } });
        expect((full as any).blockers[0].message).toContain('2 hosts');
        const capped = await blockedBy({ refused: 'org_capacity', cap: 8, open: 8, nextFreeAt: '2026-11-17T12:10:00.000Z' }).env.acquire(acquireReq);
        expect(capped).toMatchObject({ capacity: { cap: 8, nextFreeAt: '2026-11-17T12:10:00.000Z' } });
        // No numbers known (an older directory): the blocker as before, no capacity.
        expect(await blockedBy({ refused: 'no_capacity' }).env.acquire(acquireReq)).not.toHaveProperty('capacity');
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

    it('a vm claim asks the directory for a cell that satisfies it, and no cell that does is blocked capacity, sent to no cell', async () => {
        const vm = blockedBy({ refused: 'isolation_unavailable', isolation: 'vm' });
        const r = (await vm.env.acquire({ ...acquireReq, isolation: 'vm' })) as any;
        expect(vm.wanted[0]).toMatchObject({ isolation: 'vm' });
        expect(r).toMatchObject({ status: 'blocked', blockers: [{ kind: 'capacity', signature: 'isolation_unavailable' }] });
        expect(r.blockers[0].message).toContain('virtual machine');
        expect(vm.posted).toEqual([]);
        // 'any', as when the claim names none, asks the directory for no isolation.
        const any = blockedBy({ refused: 'no_capacity' });
        await any.env.acquire({ ...acquireReq, isolation: 'any' });
        expect(any.wanted[0]).not.toHaveProperty('isolation');
    });

    // F4: the deployment's minimum (RUNTIME_ISOLATION_MINIMUM) is asked by every claim that names none, so it is never placed lower.
    it("a claim that names no isolation asks the deployment's minimum; one that names its own keeps it", async () => {
        const kernel = blockedBy({ refused: 'isolation_unavailable', isolation: 'kernel' }, 'kernel');
        const r = (await kernel.env.acquire(acquireReq)) as any;
        expect(kernel.wanted[0]).toMatchObject({ isolation: 'kernel' });
        expect(r).toMatchObject({ status: 'blocked', blockers: [{ kind: 'capacity', signature: 'isolation_unavailable' }] });
        const vm = blockedBy({ refused: 'no_capacity' }, 'kernel');
        await vm.env.acquire({ ...acquireReq, isolation: 'vm' });
        expect(vm.wanted[0]).toMatchObject({ isolation: 'vm' });
    });

    it("a Run side asks for the backend of the Run's other side (same attempt, first and renewed claim); a setup claim asks none", async () => {
        const pr = blockedBy({ refused: 'no_capacity' });
        await pr.env.acquire({ ...acquireReq, runId: 'run-1', consumer: 'runtime', ref: { side: 'pr', sha: 'p' } });
        expect(pr.wanted[0]?.sameBackendAs).toEqual([claimIdFor('org-a', 'run-1:base:1'), claimIdFor('org-a', 'run-1:base:1:renewed')]);
        const base = blockedBy({ refused: 'no_capacity' });
        await base.env.acquire({ ...acquireReq, idempotencyKey: 'run-1:base:2:renewed', runId: 'run-1', consumer: 'runtime', ref: { side: 'base', sha: 'b' } });
        expect(base.wanted[0]?.sameBackendAs).toEqual([claimIdFor('org-a', 'run-1:pr:2'), claimIdFor('org-a', 'run-1:pr:2:renewed')]);
        const setup = blockedBy({ refused: 'no_capacity' });
        await setup.env.acquire({ ...acquireReq, idempotencyKey: 'setup:env-1:1', consumer: 'setup', ref: { side: 'setup', sha: 's' } });
        expect(setup.wanted[0]).not.toHaveProperty('sameBackendAs');
    });

    it("no connected cell running the other side's backend is blocked backend_unavailable, naming it, sent to no cell", async () => {
        const gone = blockedBy({ refused: 'backend_unavailable', driver: 'gvisor', isolation: 'sandboxed-container' });
        const r = (await gone.env.acquire({ ...acquireReq, runId: 'run-1', consumer: 'runtime', ref: { side: 'pr', sha: 'p' } })) as any;
        expect(r).toMatchObject({ status: 'blocked', blockers: [{ kind: 'capacity', signature: 'backend_unavailable' }] });
        expect(r.blockers[0].message).toContain('gvisor (sandboxed-container)');
        expect(gone.posted).toEqual([]);
    });

    it("a Run side tells the directory its consumer, Run and environment, so placement can bind it to the Run's own host", async () => {
        const side = blockedBy({ refused: 'no_capacity' });
        await side.env.acquire({ ...acquireReq, runId: 'run-1', consumer: 'runtime', ref: { side: 'base', sha: 'b' } });
        expect(side.wanted[0]).toMatchObject({ consumer: 'runtime', runId: 'run-1', environmentId: acquireReq.environmentId });
    });

    it("a host still starting for the Run is a capacity wait naming the pool; a host that could not start is host_unavailable, sent to no cell", async () => {
        const starting = (await blockedBy({ refused: 'no_capacity', pool: 'boat-eu-perrun', hostStarting: true }).env.acquire(acquireReq)) as any;
        expect(starting).toMatchObject({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'no_capacity' }] });
        expect(starting.blockers[0].message).toContain('pool boat-eu-perrun is starting');
        const failed = blockedBy({ refused: 'host_unavailable', pool: 'boat-eu-perrun', reason: 'registration_timeout' });
        const r = (await failed.env.acquire(acquireReq)) as any;
        expect(r).toMatchObject({ status: 'blocked', blockers: [{ kind: 'capacity', signature: 'host_unavailable' }] });
        expect(r.blockers[0].message).toContain('registration_timeout');
        expect(failed.posted).toEqual([]);
    });
});

describe('HubEnvironmentClient browser probe rounds', () => {
    // The hub lets a browser round with browser evidence run its timeout plus
    // BROWSER_ROUND_GRACE_MS (the runner container starts, records and uploads);
    // the worker must not give up on the round before the hub does.
    const browserProbe = { id: 'page', spec: { kind: 'browser', steps: [{ goto: '/' }], viewport: { width: 1280, height: 720 }, timeoutMs: 30_000 } } as any;
    const waitOf = async (probe: any, evidence?: any) => {
        const post = jest.fn(async (..._args: unknown[]) => ({ status: 200, text: '{}' }));
        await runtime(client(post)).probe('c1', probe, 's1', evidence);
        return post.mock.calls[0][3] as number;
    };

    it('a browser round that records browser evidence waits past the time the hub gives the cell for it', async () => {
        expect(await waitOf(browserProbe, { capture: ['logs', 'outbound', 'browser'] })).toBeGreaterThan(30_000 + 10_000 + BROWSER_ROUND_GRACE_MS);
    });

    it('an http probe, or a browser probe without browser evidence, keeps the step deadline', async () => {
        expect(await waitOf({ id: 'p', spec: { kind: 'http', timeoutMs: 30_000 } }, { capture: ['logs'] })).toBe(60_000);
        expect(await waitOf(browserProbe)).toBe(60_000);
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

describe("a Run side's round snapshot through the hub", () => {
    it("asks the claim's replica for a round and names it on the side's resets; without one the reset names none", async () => {
        const calls: Call[] = [];
        const env = runtime(client(async (url, headers, body) => {
            await recording(calls)(url, headers, body);
            return { status: 200, text: url.endsWith('/snapshot') ? JSON.stringify({ id: 'ksn-0123456789abcdef0123456789abcdef', purpose: 'round', ms: 4 }) : '{"ok":true}' };
        }));
        const stepId = '6f1c2d3e-4b5a-5c6d-8e7f-001122334455';
        expect(await env.snapshotRound('claim-1', stepId)).toEqual({ id: 'ksn-0123456789abcdef0123456789abcdef', ms: 4 });
        expect(calls[0]).toMatchObject({ url: 'https://hub-1/internal/claims/claim-1/snapshot', body: { organizationId: 'org-a', runId: 'run-1', stepId, purpose: 'round' } });
        await env.reset('claim-1', 'img-1', 'ksn-0123456789abcdef0123456789abcdef');
        await env.reset('claim-1', 'img-1');
        expect(calls[1]).toMatchObject({ url: 'https://hub-1/internal/claims/claim-1/reset', body: { imageId: 'img-1', roundSnapshotId: 'ksn-0123456789abcdef0123456789abcdef' } });
        expect(calls[2].body).not.toHaveProperty('roundSnapshotId');
    });

    it('answers a round the hub refused as an error, never a snapshot', async () => {
        const env = runtime(client(async () => ({ status: 409, text: JSON.stringify({ code: 'refused', message: 'the cell keeps no snapshots' }) })));
        const stepId = '6f1c2d3e-4b5a-5c6d-8e7f-001122334455';
        expect(await env.snapshotRound('claim-1', stepId)).toEqual({ code: 'transport_lost', stepId });
    });
});

describe("the PR claim's exercised lines through the hub", () => {
    const request = { files: [{ path: 'src/x.js', lines: [3] }] };
    const result = { language: 'node', files: [{ path: 'src/x.js', changedLines: 1, exercisedLines: 1, status: 'measured' }] };
    it("asks the claim's replica and returns the counts; a cell without exercisedLines or a refusal is undefined", async () => {
        const calls: Call[] = [];
        const env = runtime(client(async (url, headers, body) => {
            await recording(calls)(url, headers, body);
            return { status: 200, text: JSON.stringify({ exercised: result }) };
        }));
        expect(await env.exercisedLines('claim-1', 's1', request)).toEqual(result);
        expect(calls[0]).toMatchObject({ url: 'https://hub-1/internal/claims/claim-1/exercised', body: { organizationId: 'org-a', runId: 'run-1', stepId: 's1', exercised: request } });
        expect(await runtime(client(async () => ({ status: 200, text: '{"exercised":null}' }))).exercisedLines('claim-1', 's2', request)).toBeUndefined();
        expect(await runtime(client(async () => ({ status: 409, text: JSON.stringify({ code: 'refused', message: 'no' }) }))).exercisedLines('claim-1', 's3', request)).toBeUndefined();
    });
});
