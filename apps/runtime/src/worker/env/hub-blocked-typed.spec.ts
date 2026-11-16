import { devSealKey } from '../../testing/dev-seal-key';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import { HubClient, HubEnvironmentClient } from './hub-environment-runtime';

// The worker's border with the hub (docs §5): a blocked acquire comes back
// with a kind this worker knows (unknown otherwise) and the catalog's card.

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

function clientAnswering(body: unknown) {
    const hub = new HubClient({
        cellDirectory: { reserveCell: async () => ({ cellId: 'cell-a', replicaUrl: 'https://hub-1', owner: 'kodus' as const }), replicaForClaim: async () => 'https://hub-1' } as never,
        hubBaseUrl: 'https://hub',
        postImpl: async () => ({ status: 200, text: JSON.stringify(body) }),
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

describe('a blocked acquire through the hub', () => {
    it('comes back typed with its title and fixes', async () => {
        const r = await clientAnswering({ status: 'blocked', blockers: [{ kind: 'resources', signature: 'no_capacity', message: 'full' }], cellId: 'cell-a' }).acquire(request);
        expect(r).toMatchObject({ status: 'blocked', cellId: 'cell-a', blockers: [{ kind: 'resources', signature: 'no_capacity', message: 'full' }] });
        const [b] = (r as { blockers: Array<{ title?: string; fixes?: unknown[] }> }).blockers;
        expect(b.title).toEqual(expect.any(String));
        expect(b.fixes!.length).toBeGreaterThan(0);
    });

    it('reads a kind this worker does not know as unknown', async () => {
        const r = await clientAnswering({ status: 'blocked', blockers: [{ kind: 'from_a_newer_hub', signature: 'x', message: 'm' }] }).acquire(request);
        expect(r).toMatchObject({ status: 'blocked', blockers: [{ kind: 'unknown', signature: 'x', message: 'm' }] });
    });

    it('leaves a ready claim as the hub sent it', async () => {
        const claim = { claimId: 'c1', cellId: 'cell-a', cellOwner: 'kodus', leaseExpiresAt: 'a', hardExpiresAt: 'b', observer: { id: 'o', state: 'ready' }, manifest: { services: [], expose: [], imageId: 'img', seedSha: 's' } };
        expect(await clientAnswering(claim).acquire(request)).toEqual(claim);
    });
});
