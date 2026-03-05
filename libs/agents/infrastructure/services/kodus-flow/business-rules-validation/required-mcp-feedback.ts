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

To run business rules validation, I need at least one external MCP integration connected to fetch task/ticket context.

### Required integrations
${requiredList}

### Detected MCP providers
- ${formatAvailableProviders(params.availableProviders)}

### How to fix
- Connect an MCP integration matching the categories above in your organization/repository settings.
- Verify the connection is active.
- Run again: \`@kody -v business-logic\``;
}

export function buildMcpConnectionFailureFeedback(params: {
    userLanguage: string;
    availableProviders?: string[];
}): string {
    void params.userLanguage;

    return `## ⚠️ MCP Connection Failed

MCP integrations are configured, but I couldn't connect to any MCP server right now.

### Detected MCP providers
- ${formatAvailableProviders(params.availableProviders)}

### How to fix
- Check whether the MCP server is online and healthy.
- Review OAuth/credentials (token, client, scopes, expiration).
- Confirm integration base URL and protocol.
- Run again: \`@kody -v business-logic\``;
}

function formatAvailableProviders(providers: string[] | undefined): string {
    return providers && providers.length > 0 ? providers.join(', ') : 'none';
}
