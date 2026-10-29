export const KODUS_MCP_TOKEN_AUDIENCE = 'kodus-mcp-server';

export const KODUS_MCP_INTEGRATION_ID = 'kd_mcp_oTUrzqsaxTg';
export const KODUS_ISSUES_INTEGRATION_ID = 'kodus-issues-default';

/** The MCP servers Kodus itself serves, whose URL and token it controls. */
export function isFirstPartyMcpIntegration(integrationId?: string): boolean {
    return (
        integrationId === KODUS_MCP_INTEGRATION_ID ||
        integrationId === KODUS_ISSUES_INTEGRATION_ID
    );
}
