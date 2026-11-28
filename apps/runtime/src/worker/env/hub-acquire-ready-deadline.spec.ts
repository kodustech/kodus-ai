import { devSealKey } from '../../testing/dev-seal-key';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import { HubClient, HubEnvironmentClient, HubRequestTimeoutError, READY_ANSWER_GRACE_MS } from './hub-environment-runtime';

// A boot that began on an earlier call (opts.readyBy) waits only until its
// ready deadline: the hub may answer a round sent again with a fresh ready
// wait, and the worker must not wait it.

const secrets = new SealedSecretOpener(devSealKey());
const request = {
    organizationId: 'org-a',
    environmentId: 'env-1',
    runId: 'run-1',
    imageId: 'img',
    ref: { side: 'pr' as const, sha: 'abc' },
    consumer: 'runtime' as const,
    idempotencyKey: 'run-1:pr:1',
};

function clientWith(post: (url: string, headers: Record<string, string>, body: string, timeoutMs: number) => Promise<{ status: number; text: string }>) {
    const hub = new HubClient({
        cellDirectory: { reserveCell: async () => ({ cellId: 'cell-a', replicaUrl: 'https://hub-1', owner: 'kodus' as const }), replicaForClaim: async () => 'https://hub-1' } as never,
        hubBaseUrl: 'https://hub',
        postImpl: post,
    });
    return new HubEnvironmentClient(hub, secrets, {
        correlationId: 'corr',
        organizationId: 'org-a',
        runId: 'run-1',
        repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' } as never,
        sealedRepoToken: secrets.seal('ghs_plain', 'run-1'),
        tokenBinding: 'run-1',
        imageId: 'img',
        expose: [],
    });
}

describe('an acquire with a ready deadline', () => {
    it('is boot_timeout without asking the hub when the deadline has passed', async () => {
        const post = jest.fn(async () => ({ status: 200, text: '{}' }));
        const r = await clientWith(post).acquire(request, { readyBy: Date.now() - 1 });
        expect(r).toMatchObject({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'boot_timeout' }] });
        expect(post).not.toHaveBeenCalled();
    });

    it('gives the hub only the rest of the wait, and is boot_timeout when the hub is still waiting at the deadline', async () => {
        const readyBy = Date.now() + 40;
        const timeouts: number[] = [];
        const r = await clientWith(async (_url, _h, _b, timeoutMs) => {
            timeouts.push(timeoutMs);
            // The hub waits a fresh ready wait; the worker's own timer ends the call.
            await new Promise((done) => setTimeout(done, 60));
            throw new HubRequestTimeoutError();
        }).acquire(request, { readyBy });
        expect(r).toMatchObject({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'boot_timeout' }] });
        expect(timeouts[0]).toBeLessThanOrEqual(40 + READY_ANSWER_GRACE_MS);
    });

    it('keeps the hub whole wait without a deadline (a first send)', async () => {
        const timeouts: number[] = [];
        await clientWith(async (_url, _h, _b, timeoutMs) => {
            timeouts.push(timeoutMs);
            return { status: 200, text: JSON.stringify({ status: 'blocked', blockers: [] }) };
        }).acquire(request);
        expect(timeouts).toEqual([31 * 60_000]);
    });
});
