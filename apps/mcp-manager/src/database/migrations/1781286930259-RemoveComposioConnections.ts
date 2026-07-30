import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Composio is fully decommissioned. Drop any remaining Composio-provider MCP
 * connections — orgs re-connect those toolkits through the native (kodusmcp)
 * integrations. Irreversible (the rows pointed at the retired Composio dev
 * project), so `down` is a no-op.
 */
export class RemoveComposioConnections1781286930259
    implements MigrationInterface
{
    name = 'RemoveComposioConnections1781286930259';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DELETE FROM "mcp-manager"."mcp_connections"
            WHERE "provider" = 'composio'
        `);
    }

    public async down(): Promise<void> {
        // No-op: deleted Composio connections cannot be restored.
    }
}
