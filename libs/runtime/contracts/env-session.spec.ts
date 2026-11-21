import { EnvSessionOpenSchema } from './env-session';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const open = (workspace?: unknown[]) => ({
    organizationId: 'org',
    teamId: 'team',
    keyId: 'key',
    repositoryIds: ['repo-shop', 'repo-billing'],
    repositoryId: 'repo-shop',
    environmentId: 'env',
    sessionId: '00000000-0000-4000-8000-000000000000',
    sha: A,
    repositoryFullName: 'acme/shop',
    sealedRepoToken: 'sealed:v1:shop',
    correlationId: 'mcp:x',
    ...(workspace ? { workspace } : {}),
});
const shop = { repositoryId: 'repo-shop', fullName: 'acme/shop', alias: 'shop', role: 'primary', sha: A, sealedRepoToken: 'sealed:v1:shop' };
const billing = { repositoryId: 'repo-billing', fullName: 'acme/billing', alias: 'billing', role: 'member', sha: B, sealedRepoToken: 'sealed:v1:billing' };

describe('EnvSessionOpenSchema', () => {
    it('opens a session of one repository with no workspace, or of several with the primary being the session itself', () => {
        expect(EnvSessionOpenSchema.safeParse(open()).success).toBe(true);
        expect(EnvSessionOpenSchema.safeParse(open([shop, billing])).success).toBe(true);
    });

    it('refuses a workspace whose primary is not the session repository at its commit and token, or that repeats an alias', () => {
        expect(EnvSessionOpenSchema.safeParse(open([{ ...shop, role: 'member' }, { ...billing, role: 'primary' }])).success).toBe(false);
        expect(EnvSessionOpenSchema.safeParse(open([{ ...shop, sha: B }, billing])).success).toBe(false);
        expect(EnvSessionOpenSchema.safeParse(open([{ ...shop, sealedRepoToken: 'other' }, billing])).success).toBe(false);
        expect(EnvSessionOpenSchema.safeParse(open([shop, { ...billing, alias: 'shop' }])).success).toBe(false);
    });
});
