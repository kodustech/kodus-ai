import { PgTemplateSetupRequester } from './pg-template-setup-requester';

const req = { organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', fingerprint: 'c'.repeat(64), key: 'template:org-1/env-1:tpl-x', boundKey: 'template:org-1/env-1' };

describe('when the fleet asks for the setup of an environment template', () => {
    it("marks only the environment's building row of that pool and fingerprint with the command key", async () => {
        const calls: Array<{ sql: string; params: unknown[] }> = [];
        const db = { query: async (sql: string, params: unknown[]) => (calls.push({ sql, params }), { rowCount: 1, rows: [] }) } as any;
        await new PgTemplateSetupRequester(db).request(req);
        expect(calls).toHaveLength(1);
        expect(calls[0].sql).toMatch(/UPDATE runtime\.runtime_env_templates SET setup_key = \$5, setup_requested_at = now\(\)/);
        expect(calls[0].sql).toMatch(/WHERE org_id = \$1 AND environment_id = \$2 AND pool_id = \$3 AND fingerprint = \$4 AND state = 'building'/);
        expect(calls[0].params).toEqual(['org-1', 'env-1', 'p', 'c'.repeat(64), 'template:org-1/env-1:tpl-x']);
    });
    it('fails when that environment has no building row, so the host never waits for a setup nobody will request', async () => {
        const db = { query: async () => ({ rowCount: 0, rows: [] }) } as any;
        await expect(new PgTemplateSetupRequester(db).request(req)).rejects.toThrow('template_row_not_building');
    });
});
