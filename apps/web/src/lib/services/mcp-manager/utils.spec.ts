/**
 * mcpManagerFetch is dual-mode:
 *   - Server side: hits the internal MCP Manager host directly (env vars
 *     WEB_HOSTNAME_MCP_MANAGER / GLOBAL_MCP_MANAGER_CONTAINER_NAME).
 *   - Client side: routes through /api/proxy/mcp/<path> so the internal
 *     hostname never ships in the browser bundle.
 *
 * This test locks in both paths. A regression here either re-leaks the
 * hostname or breaks server-side callers that talk to the MCP service.
 */

jest.mock("src/core/utils/server-side", () => {
    const mod = { isServerSide: true };
    return {
        get isServerSide() {
            return mod.isServerSide;
        },
        __setServerSide: (v: boolean) => {
            mod.isServerSide = v;
        },
    };
});

const createUrlMock = jest.fn(
    (host: string | undefined, port: string | undefined, path: string) =>
        `http://${host}:${port}${path}`,
);
jest.mock("src/core/utils/helpers", () => ({
    createUrl: (...args: unknown[]) => (createUrlMock as any)(...args),
}));

jest.mock("src/core/utils/session", () => ({
    getJWTToken: jest.fn().mockResolvedValue("client-token"),
}));

jest.mock("src/core/config/auth", () => ({
    auth: jest
        .fn()
        .mockResolvedValue({ user: { accessToken: "server-token" } }),
}));

const typedFetchMock = jest.fn();
jest.mock("@services/fetch", () => ({
    typedFetch: (...args: unknown[]) => typedFetchMock(...args),
}));

const setServer = (v: boolean) => {
    const mod = require("src/core/utils/server-side");
    mod.__setServerSide(v);
};

describe("mcpManagerFetch dual-mode", () => {
    const ORIG = {
        host: process.env.WEB_HOSTNAME_MCP_MANAGER,
        port: process.env.WEB_PORT_MCP_MANAGER,
        container: process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME,
    };

    beforeEach(() => {
        jest.resetModules();
        createUrlMock.mockClear();
        typedFetchMock.mockReset();
        typedFetchMock.mockResolvedValue({ ok: true });
        process.env.WEB_HOSTNAME_MCP_MANAGER = "mcp.internal";
        process.env.WEB_PORT_MCP_MANAGER = "4040";
    });

    afterAll(() => {
        process.env.WEB_HOSTNAME_MCP_MANAGER = ORIG.host;
        process.env.WEB_PORT_MCP_MANAGER = ORIG.port;
        process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME = ORIG.container;
    });

    it("server side: goes straight to the internal host + uses NextAuth token", async () => {
        setServer(true);
        const { mcpManagerFetch } = await import("./utils");
        await mcpManagerFetch("/integrations");
        const [url, init] = typedFetchMock.mock.calls[0];
        expect(url).toBe("http://mcp.internal:4040/integrations");
        expect(init.headers.Authorization).toBe("Bearer server-token");
    });

    it("server side: resolves 'localhost' to the container name", async () => {
        setServer(true);
        process.env.WEB_HOSTNAME_MCP_MANAGER = "localhost";
        process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME = "my-mcp-container";
        const { mcpManagerFetch } = await import("./utils");
        await mcpManagerFetch("/integrations");
        const [url] = typedFetchMock.mock.calls[0];
        expect(url).toBe("http://my-mcp-container:4040/integrations");
    });

    it("client side: goes through /api/proxy/mcp and uses browser JWT", async () => {
        setServer(false);
        const { mcpManagerFetch } = await import("./utils");
        await mcpManagerFetch("/integrations");
        const [url, init] = typedFetchMock.mock.calls[0];
        expect(url).toBe("/api/proxy/mcp/integrations");
        expect(init.headers.Authorization).toBe("Bearer client-token");
    });

    it("client side: internal hostname does not appear in the URL", async () => {
        setServer(false);
        const { mcpManagerFetch } = await import("./utils");
        await mcpManagerFetch("/integrations");
        const [url] = typedFetchMock.mock.calls[0];
        expect(url).not.toContain("mcp.internal");
        expect(url).not.toContain("4040");
    });

    it("client side: adds leading slash when the caller omits one", async () => {
        setServer(false);
        const { mcpManagerFetch } = await import("./utils");
        await mcpManagerFetch("integrations");
        const [url] = typedFetchMock.mock.calls[0];
        expect(url).toBe("/api/proxy/mcp/integrations");
    });

    // Regression guard: MCP fetcher must flag createUrl as internal so
    // the http+port branch fires in self-hosted. Mirrors the billing
    // utils + billing/mcp proxy route behavior.
    it("server side: flags createUrl as internal", async () => {
        setServer(true);
        process.env.WEB_HOSTNAME_MCP_MANAGER = "localhost";
        process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME = "my-mcp-container";
        const { mcpManagerFetch } = await import("./utils");
        await mcpManagerFetch("/integrations");
        const [, , , options] = createUrlMock.mock.calls[0];
        expect(options).toEqual({ internal: true });
    });
});
