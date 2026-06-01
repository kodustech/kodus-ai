export default () => ({
    port: parseInt(process.env.API_MCP_MANAGER_PORT, 10) || 3101,
    composio: {
        apiKey: process.env.API_MCP_MANAGER_COMPOSIO_API_KEY,
        baseUrl: process.env.API_MCP_MANAGER_COMPOSIO_BASE_URL,
    },
    redirectUri: process.env.API_MCP_MANAGER_REDIRECT_URI,
    providers: process.env.API_MCP_MANAGER_MCP_PROVIDERS,
    encryption: {
        secret: process.env.API_MCP_MANAGER_ENCRYPTION_SECRET,
    },
});
