type RequiredMcpInfo = {
    category: string;
    label: string;
    examples?: string;
};

export function buildRequiredMcpFeedback(params: {
    requiredMcps: RequiredMcpInfo[];
    userLanguage: string;
    availableProviders?: string[];
}): string {
    void params.userLanguage;

    const requiredList = params.requiredMcps.length
        ? params.requiredMcps
              .map((mcp) =>
                  mcp.examples
                      ? `- **${mcp.label}** (${mcp.examples})`
                      : `- **${mcp.label}**`,
              )
              .join('\n')
        : '- **Task Management** (Jira, Linear, Notion)';

    return `## 🔌 MCP Integration Required

Business validation compares the PR implementation with task/ticket requirements.
I could not fetch task context because no compatible MCP integration is currently connected.

### Required integrations
${requiredList}

### Detected MCP providers
- ${formatAvailableProviders(params.availableProviders)}

### Next steps
- Connect at least one MCP provider from the required categories in organization/repository settings.
- Ensure the provider is healthy and authenticated (OAuth/token/scopes).
- Re-run business validation after the connection is active.`;
}

export function buildMcpConnectionFailureFeedback(params: {
    userLanguage: string;
    availableProviders?: string[];
}): string {
    void params.userLanguage;

    return `## ⚠️ MCP Connection Failed

MCP integrations are configured, but I couldn't connect to any provider right now.

### Detected MCP providers
- ${formatAvailableProviders(params.availableProviders)}

### Next steps
- Check whether the MCP provider/server is online and healthy.
- Review OAuth/credentials (token, client, scopes, expiration).
- Confirm integration base URL and protocol.
- Re-run business validation.`;
}

function formatAvailableProviders(providers: string[] | undefined): string {
    return providers && providers.length > 0 ? providers.join(', ') : 'none';
}
