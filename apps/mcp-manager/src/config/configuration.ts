export default () => ({
    port: parseInt(process.env.API_MCP_MANAGER_PORT, 10) || 3101,
    redirectUri: process.env.API_MCP_MANAGER_REDIRECT_URI,
    providers: process.env.API_MCP_MANAGER_MCP_PROVIDERS,
    encryption: {
        secret: process.env.API_MCP_MANAGER_ENCRYPTION_SECRET,
    },
});
