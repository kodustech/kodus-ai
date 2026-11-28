import type { GrantRequest, ImageStoreConfig, ImageStoreProvider, StoreEndpoint, StoreGrant } from './image-store';

// The in-process image store provider: the conformance suite's reference and the hub's specs. It mints a token
// that names its claim and its repositories and makes no network call; `failNext` makes the next grant throw.
export class FakeImageStoreProvider implements ImageStoreProvider {
    readonly kind = 'fake' as const;
    readonly grants: Array<{ claimId: string; repos: string[]; expiresAt: string }> = [];
    readonly revoked: string[] = [];
    private failure?: Error;

    failNext(error: Error = new Error('the store is down')) {
        this.failure = error;
    }

    endpointFor(config: ImageStoreConfig): StoreEndpoint {
        return { endpoint: 'https://store.fake.invalid', prefix: config.prefix };
    }

    async grant(config: ImageStoreConfig, req: GrantRequest, now: Date): Promise<StoreGrant> {
        if (req.repos.length === 0) throw new Error('a grant names at least one repository');
        if (this.failure) {
            const e = this.failure;
            this.failure = undefined;
            throw e;
        }
        const expiresAt = new Date(now.getTime() + req.ttlSeconds * 1000).toISOString();
        this.grants.push({ claimId: req.claimId, repos: req.repos.map((r) => `${r.name}:${r.push ? 'push' : 'pull'}`), expiresAt });
        return { ...this.endpointFor(config), token: `fake.${req.claimId}.${this.grants.length}`, expiresAt, repos: req.repos.map((r) => ({ ...r })) };
    }

    async revoke(claimId: string): Promise<void> {
        this.revoked.push(claimId);
    }
}
