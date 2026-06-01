/**
 * Custom error for MCP Manager service unavailable.
 *
 * Split out from `utils.ts` so client components (e.g. use-mcp-mentions)
 * can import this without pulling in server-only fetch helpers guarded
 * by `import 'server-only'`.
 */
export class MCPServiceUnavailableError extends Error {
    constructor(message = "MCP Manager service is not available") {
        super(message);
        this.name = "MCPServiceUnavailableError";
    }
}
