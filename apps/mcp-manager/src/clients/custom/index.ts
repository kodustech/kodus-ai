import { createMCPAdapter, MCPAdapter } from '@kodus/flow';
import { MCPIntegrationAuthType } from '../../modules/integrations/enums/integration.enum';
import { MCPIntegrationInterface } from '../../modules/integrations/interfaces/mcp-integration.interface';
import {
    MCPProviderType,
    MCPTool,
} from '../../modules/providers/interfaces/provider.interface';

export class CustomClient {
    private readonly clientInstance: MCPAdapter;
    private connected: boolean = false;
    private connectionCount: number = 0;
    private connectionPromise: Promise<void> | null = null;

    constructor(
        private readonly integration: MCPIntegrationInterface & {
            serverName?: string;
            providerType?: MCPProviderType;
        },
    ) {
        this.clientInstance = createMCPAdapter({
            servers: [
                {
                    name: this.integration.serverName || 'custom-server',
                    type: this.integration.protocol,
                    url: this.integration.baseUrl,
                    headers: this.buildHeaders(),
                },
            ],
        });
    }

    private buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            ...this.integration.headers,
        };

        switch (this.integration.authType) {
            case MCPIntegrationAuthType.BEARER_TOKEN:
                headers['Authorization'] =
                    `Bearer ${this.integration.bearerToken}`;
                break;
            case MCPIntegrationAuthType.API_KEY:
                headers[this.integration.apiKeyHeader] =
                    this.integration.apiKey;
                break;
            case MCPIntegrationAuthType.BASIC:
                const basicAuth = Buffer.from(
                    `${this.integration.basicUser}:${this.integration.basicPassword || ''}`,
                ).toString('base64');
                headers['Authorization'] = `Basic ${basicAuth}`;
                break;
            case MCPIntegrationAuthType.OAUTH2:
                if (this.integration.tokens?.accessToken) {
                    headers['Authorization'] =
                        `Bearer ${this.integration.tokens.accessToken}`;
                }
                break;
            case MCPIntegrationAuthType.NONE:
            default:
                break;
        }

        return headers;
    }

    async connect() {
        this.connectionCount++;
        if (this.connected) return;

        if (this.connectionPromise) {
            await this.connectionPromise;
            return;
        }

        this.connectionPromise = (async () => {
            try {
                await this.clientInstance.connect();
                this.connected = true;
            } finally {
                this.connectionPromise = null;
            }
        })();

        await this.connectionPromise;
    }

    async disconnect() {
        this.connectionCount--;
        if (this.connectionCount > 0) return;

        // Safety reset
        this.connectionCount = 0;

        if (!this.connected) return;

        this.connected = false;
        await this.clientInstance.disconnect();
    }

    async getTools(): Promise<MCPTool[]> {
        try {
            await this.connect();
            const response = await this.clientInstance.getTools();

            if (!Array.isArray(response)) {
                throw new Error('Tools endpoint did not return an array');
            }

            return response.map((tool) => ({
                slug: tool.name,
                name: tool.name,
                description: tool.description,
                provider:
                    this.integration.providerType || MCPProviderType.CUSTOM,
                warning: false,
            }));
        } catch (error) {
            console.error(`Failed to fetch custom tools:`, error.message);
            throw new Error(
                `Failed to fetch tools from custom integration: ${error.message}`,
            );
        } finally {
            await this.disconnect();
        }
    }
}
