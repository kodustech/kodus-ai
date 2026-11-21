import { EnvSessionOpenSchema, EnvSessionWorkspaceRepositorySchema } from './env-session';
import { PreviewOpenSchema } from './preview';
import { RuntimeEgressApprovedSchema, RuntimeEgressRevokedSchema } from './runtime-commands';

// What crosses a process boundary is checked at the schema: a token travels
// sealed, never plain, and an egress host is the exact hostname the proxy
// and the protocol compare.

const PLAIN = 'ghs_plainDownloadToken0123456789';

describe('a repository token in a session or a preview open', () => {
    it('is refused plain, in the env session, its workspace repositories and the preview open', () => {
        const session = EnvSessionOpenSchema.safeParse({ sealedRepoToken: PLAIN });
        expect(session.success).toBe(false);
        expect(session.error?.issues.some((i) => i.path[0] === 'sealedRepoToken')).toBe(true);
        const member = EnvSessionWorkspaceRepositorySchema.safeParse({ sealedRepoToken: PLAIN });
        expect(member.error?.issues.some((i) => i.path[0] === 'sealedRepoToken')).toBe(true);
        const preview = PreviewOpenSchema.safeParse({ sealedRepoToken: PLAIN });
        expect(preview.error?.issues.some((i) => i.path[0] === 'sealedRepoToken')).toBe(true);
    });
});

describe('the host of an egress approval or revocation', () => {
    const approval = (host: string) => ({
        environmentId: 'env-1',
        organizationId: 'org-1',
        host,
        approvedBy: { userId: 'u-1' },
        approvedAt: '2026-11-13T12:00:00.000Z',
        key: `env-1:${host}`,
    });
    const revocation = (host: string) => ({ environmentId: 'env-1', organizationId: 'org-1', host, revokedBy: { userId: 'u-1' }, revokedAt: '2026-11-13T12:00:00.000Z', key: `env-1:${host}` });

    it.each(['*.example.com', 'example.com:443', 'https://example.com', 'example.com/x', 'exa mple.com', '-x.example.com', ''])('refuses %s', (host) => {
        expect(RuntimeEgressApprovedSchema.safeParse(approval(host)).success).toBe(false);
        expect(RuntimeEgressRevokedSchema.safeParse(revocation(host)).success).toBe(false);
    });

    it.each([
        ['api.example.com', 'api.example.com'],
        ['API.Example.COM', 'api.example.com'],
        ['example.com.', 'example.com'],
    ])('reads %s as the exact hostname %s', (host, exact) => {
        expect(RuntimeEgressApprovedSchema.parse(approval(host)).host).toBe(exact);
        expect(RuntimeEgressRevokedSchema.parse(revocation(host)).host).toBe(exact);
    });
});
