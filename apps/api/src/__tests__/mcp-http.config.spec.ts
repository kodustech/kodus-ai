import {
    applyMcpHttpResponseHeaders,
    isAllowedMcpOrigin,
} from '@libs/mcp-server/utils/mcp-http.config';

describe('mcp-http.config', () => {
    it('applies exposed MCP headers to an HTTP response', () => {
        const response = {
            setHeader: jest.fn(),
        };

        applyMcpHttpResponseHeaders(response as any);

        expect(response.setHeader).toHaveBeenCalledWith(
            'Access-Control-Expose-Headers',
            'Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
        );
    });

    it('allows absent origin headers for server-to-server MCP requests', () => {
        expect(
            isAllowedMcpOrigin({
                origin: undefined,
                requestOrigin: 'https://api.kodus.io',
            }),
        ).toBe(true);
    });

    it('allows same-origin MCP browser requests', () => {
        expect(
            isAllowedMcpOrigin({
                origin: 'https://api.kodus.io',
                requestOrigin: 'https://api.kodus.io',
            }),
        ).toBe(true);
    });

    it('rejects unexpected browser origins for MCP requests', () => {
        expect(
            isAllowedMcpOrigin({
                origin: 'https://evil.example',
                requestOrigin: 'https://api.kodus.io',
            }),
        ).toBe(false);
    });
});
