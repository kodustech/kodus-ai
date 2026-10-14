jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: jest.fn(),
    MCPAdapter: class {},
}));

import { FindOperator } from 'typeorm';

import { McpService } from '../../src/modules/mcp/mcp.service';

/**
 * Production 2026-09-28: every review of some orgs tried to register MCP
 * servers that Kodus no longer runs — "Context7" (dropped from the managed
 * catalog on 2026-07-01, its Railway app since deleted) and "Github Issues by
 * Kodus" (replaced by Kodus Issues on 2026-06-12; its /mcp/github-issues route
 * is gone). The connection rows outlived the catalog entries, so each review
 * paid a 404 per server, and on the free plan — which keeps the OLDEST three
 * connections — a dead one could hold a slot a working one needed.
 */
describe('McpService.getConnections — retired managed integrations', () => {
    function makeService(rows: any[] = []) {
        const connectionRepository = {
            findAndCount: jest.fn().mockResolvedValue([rows, rows.length]),
        };
        const service = new McpService(
            {} as any,
            connectionRepository as any,
            {} as any,
            {} as any,
            {} as any,
        );
        return { service, connectionRepository };
    }

    const whereOf = (repo: { findAndCount: jest.Mock }) =>
        repo.findAndCount.mock.calls[0][0].where;

    it('leaves retired integrations out of the query itself', async () => {
        const { service, connectionRepository } = makeService();

        await service.getConnections({ page: 1, pageSize: 50 } as any, 'org-1');

        const where = whereOf(connectionRepository);
        expect(where.organizationId).toBe('org-1');
        const filter = where.integrationId as FindOperator<unknown>;
        expect(filter).toBeInstanceOf(FindOperator);
        expect(JSON.stringify(filter)).toContain('context7-default');
        expect(JSON.stringify(filter)).toContain('kodus-github-issues-default');
    });

    it('returns nothing when the caller asks for a retired integration by id', async () => {
        const { service, connectionRepository } = makeService([
            { id: 'c1', integrationId: 'context7-default' },
        ]);

        const res = await service.getConnections(
            { page: 1, pageSize: 50, integrationId: 'context7-default' } as any,
            'org-1',
        );

        expect(res).toEqual({ items: [], total: 0 });
        expect(connectionRepository.findAndCount).not.toHaveBeenCalled();
    });

    it('keeps an explicit filter on a live integration as it was', async () => {
        const { service, connectionRepository } = makeService();

        await service.getConnections(
            { page: 1, pageSize: 50, integrationId: 'kodus-issues-default' } as any,
            'org-1',
        );

        expect(whereOf(connectionRepository).integrationId).toBe(
            'kodus-issues-default',
        );
    });

    it('still pins the tenant from auth, never from the query', async () => {
        const { service, connectionRepository } = makeService();

        await service.getConnections(
            { page: 1, pageSize: 50, organizationId: 'other-org' } as any,
            'org-1',
        );

        expect(whereOf(connectionRepository).organizationId).toBe('org-1');
    });
});
