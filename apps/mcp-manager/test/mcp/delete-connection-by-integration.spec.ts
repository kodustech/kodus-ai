// createMCPAdapter moved from @kodus/flow to @libs/mcp-server/mcp-adapter in the
// ai-sdk migration (@kodus/flow was removed from the repo).
jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: jest.fn(),
}));

import { McpService } from '../../src/modules/mcp/mcp.service';

const ORG = 'org-1';
const INTEGRATION_ID = 'atlassian-rovo-default';
// In real data the connection PK differs from the integrationId — the crux of
// the prod "Connection ID not found" bug.
const CONNECTION_PK = 'd8de7d3e-9dbf-4f73-8471-62cde9d9f1a5';
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildService({ hasConnectionRow = true } = {}) {
    const connection = hasConnectionRow
        ? {
              id: CONNECTION_PK,
              integrationId: INTEGRATION_ID,
              organizationId: ORG,
              provider: 'kodusmcp',
          }
        : null;

    // Mirrors the real repository: found by PK OR integrationId (scoped to org),
    // PK !== integrationId, and `id` is a uuid column — querying it with a
    // non-uuid errors at the database, exactly like Postgres. (An earlier mock
    // skipped this and hid a real bug.)
    const connectionRepository = {
        findOne: jest.fn(({ where }: any) => {
            const conditions = Array.isArray(where) ? where : [where];
            for (const c of conditions) {
                if (c.organizationId !== ORG) continue;
                if (c.id !== undefined) {
                    if (!UUID_RE.test(c.id)) {
                        return Promise.reject(
                            new Error(
                                `invalid input syntax for type uuid: "${c.id}"`,
                            ),
                        );
                    }
                    if (connection && c.id === connection.id) {
                        return Promise.resolve(connection);
                    }
                }
                if (connection && c.integrationId === connection.integrationId) {
                    return Promise.resolve(connection);
                }
            }
            return Promise.resolve(null);
        }),
        delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const provider = {
        deleteConnection: jest.fn().mockResolvedValue(undefined),
    };
    const providerFactory = {
        getProvider: jest.fn().mockReturnValue(provider),
    };
    const integrationOAuthService = {
        deleteOAuthState: jest.fn().mockResolvedValue(undefined),
    };

    const service = new McpService(
        providerFactory as any,
        connectionRepository as any,
        {} as any,
        {} as any,
        integrationOAuthService as any,
    );

    return { service, connectionRepository, integrationOAuthService };
}

describe('McpService.deleteConnection', () => {
    it('deletes by the connection PK and clears the OAuth credential', async () => {
        const { service, connectionRepository, integrationOAuthService } =
            buildService();

        await expect(
            service.deleteConnection(CONNECTION_PK, ORG),
        ).resolves.toEqual({ message: 'Connection deleted successfully' });

        expect(connectionRepository.delete).toHaveBeenCalledWith(CONNECTION_PK);
        expect(integrationOAuthService.deleteOAuthState).toHaveBeenCalledWith(
            ORG,
            INTEGRATION_ID,
        );
    });

    // The web falls back to the integrationId (route param) when the connections
    // list didn't surface the PK. The row exists, so it's deleted by its real PK
    // and the credential is cleared.
    it('deletes by integrationId when the UI only has the integrationId', async () => {
        const { service, connectionRepository, integrationOAuthService } =
            buildService();

        await expect(
            service.deleteConnection(INTEGRATION_ID, ORG),
        ).resolves.toEqual({ message: 'Connection deleted successfully' });

        expect(connectionRepository.delete).toHaveBeenCalledWith(CONNECTION_PK);
        expect(integrationOAuthService.deleteOAuthState).toHaveBeenCalledWith(
            ORG,
            INTEGRATION_ID,
        );
    });

    // The actual prod root cause: the credential exists (mcp_integration_oauth)
    // but there is NO row in mcp_connections — the tables drifted. The plugin
    // shows connected, the UI has only the integrationId, and disconnect must
    // still clear the credential instead of failing with "not found".
    it('disconnects a credential-only integration with no connection row', async () => {
        const { service, connectionRepository, integrationOAuthService } =
            buildService({ hasConnectionRow: false });

        await expect(
            service.deleteConnection(INTEGRATION_ID, ORG),
        ).resolves.toEqual({ message: 'Connection deleted successfully' });

        // No row to delete...
        expect(connectionRepository.delete).not.toHaveBeenCalled();
        // ...but the credential is cleared — this is what truly disconnects.
        expect(integrationOAuthService.deleteOAuthState).toHaveBeenCalledWith(
            ORG,
            INTEGRATION_ID,
        );
    });
});
