import { wrapToolHandler } from './mcp-protocol.utils';

/**
 * GHSA-5rf5-5rj3-37cv #1 — MCP tools must take organizationId/teamId from the
 * authenticated principal, never from the JSON-RPC arguments. That boundary has
 * a SINGLE owner: `McpToolAuthorizer` (see mcp-tool-authorizer.service.spec.ts),
 * which runs before the handler in both server factories, REJECTS a mismatched
 * org/team and fills an absent team-key teamId. `wrapToolHandler` must not also
 * rewrite those fields — two rules on one boundary is how a silent-overwrite
 * path slips back in. These tests pin that the wrapper forwards args untouched.
 */
describe('wrapToolHandler — does not own the tenant boundary (GHSA-5rf5 #1)', () => {
    const principalExtra = (principal: any) => ({
        authInfo: { extra: { principal } },
    });

    it('forwards tenant fields to the handler unchanged (the authorizer already pinned them)', async () => {
        const seen: any = {};
        const wrapped = wrapToolHandler(async (args: any) => {
            seen.organizationId = args.organizationId;
            seen.teamId = args.teamId;
            return { ok: true };
        });

        // In production the authorizer has already replaced/rejected these
        // before the wrapper runs; the wrapper itself leaves them as received.
        await wrapped(
            { organizationId: 'org-1', teamId: 'team-1' },
            principalExtra({
                kind: 'team-key',
                organizationId: 'org-1',
                teamId: 'team-1',
            }),
        );

        expect(seen).toEqual({ organizationId: 'org-1', teamId: 'team-1' });
    });

    it('does not overwrite an argument org with the principal org', async () => {
        const seen: any = {};
        const wrapped = wrapToolHandler(async (args: any) => {
            seen.organizationId = args.organizationId;
            return { ok: true };
        });

        await wrapped(
            { organizationId: 'arg-org' },
            principalExtra({ kind: 'service', organizationId: 'principal-org' }),
        );

        expect(seen.organizationId).toBe('arg-org');
    });

    it('still runs the handler and returns its result', async () => {
        const wrapped = wrapToolHandler(async () => ({ value: 42 }));
        const res = await wrapped({ organizationId: 'org-1' }, undefined);
        expect(res.structuredContent).toEqual({ value: 42 });
    });
});
