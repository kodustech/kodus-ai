import { wrapToolHandler } from './mcp-protocol.utils';

/**
 * GHSA-5rf5-5rj3-37cv #1 — MCP tools read organizationId/teamId from the
 * JSON-RPC arguments, so a caller authenticated for one organization could act
 * on another by passing its id. wrapToolHandler now overwrites those from the
 * authenticated principal before the handler runs.
 */
describe('wrapToolHandler — tenant comes from the principal (GHSA-5rf5 #1)', () => {
    const principalExtra = (principal: any) => ({
        authInfo: { extra: { principal } },
    });

    it('overrides a client-supplied organizationId with the principal org', async () => {
        const seen: any = {};
        const wrapped = wrapToolHandler(async (args: any) => {
            seen.organizationId = args.organizationId;
            return { ok: true };
        });

        await wrapped(
            { organizationId: 'victim-org', teamId: 'tX' },
            principalExtra({ kind: 'service', organizationId: 'my-org' }),
        );

        expect(seen.organizationId).toBe('my-org');
    });

    it('pins org AND team from a team-key principal', async () => {
        const seen: any = {};
        const wrapped = wrapToolHandler(async (args: any) => {
            seen.organizationId = args.organizationId;
            seen.teamId = args.teamId;
            return { ok: true };
        });

        await wrapped(
            { organizationId: 'victim-org', teamId: 'victim-team' },
            principalExtra({
                kind: 'team-key',
                organizationId: 'my-org',
                teamId: 'my-team',
            }),
        );

        expect(seen).toEqual({ organizationId: 'my-org', teamId: 'my-team' });
    });

    it('keeps args.teamId for a service principal (org still pinned)', async () => {
        const seen: any = {};
        const wrapped = wrapToolHandler(async (args: any) => {
            seen.organizationId = args.organizationId;
            seen.teamId = args.teamId;
            return { ok: true };
        });

        await wrapped(
            { organizationId: 'victim-org', teamId: 't-from-args' },
            principalExtra({ kind: 'service', organizationId: 'my-org' }),
        );

        expect(seen).toEqual({ organizationId: 'my-org', teamId: 't-from-args' });
    });

    it('does not inject when there is no principal (McpAuthGuard is the gate)', async () => {
        // The guard rejects an unauthenticated tools/call before it reaches
        // here, so a principal is always present in production. With none, the
        // wrapper simply does not pin — it must not invent an org.
        const seen: any = {};
        const wrapped = wrapToolHandler(async (args: any) => {
            seen.organizationId = args.organizationId;
            return { ok: true };
        });

        await wrapped({ organizationId: 'whatever' }, undefined);

        expect(seen.organizationId).toBe('whatever');
    });
});
