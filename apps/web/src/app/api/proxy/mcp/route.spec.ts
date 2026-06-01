/**
 * /api/proxy/mcp/[...path]/route.ts — forwards browser fetches to the
 * internal MCP Manager. Same forwarding contract as the /api proxy,
 * plus: injects a Bearer token resolved from NextAuth's server-side
 * session; resolves 'localhost' hostname to the container name so the
 * next hop works from inside the web container.
 */

jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("src/core/utils/helpers", () => ({
    createUrl: (host: string, port: string, path: string) =>
        `http://${host}:${port}${path}`,
}));

const authMock = jest.fn();
jest.mock("src/core/config/auth", () => ({
    auth: () => authMock(),
}));

import { GET, POST } from "./[...path]/route";

function mockReq(method: string, init?: { search?: string; body?: any }): any {
    const headers = new Headers({
        host: "app.example.com",
        cookie: "auth=abc",
    });
    return {
        method,
        headers,
        body: init?.body ?? null,
        nextUrl: { search: init?.search ?? "" },
    };
}

function ctx(path: string[]) {
    return { params: Promise.resolve({ path }) };
}

describe("/api/proxy/mcp/[...path]", () => {
    const originalFetch = global.fetch;
    let fetchMock: jest.Mock;
    const ENV_ORIG = {
        host: process.env.WEB_HOSTNAME_MCP_MANAGER,
        port: process.env.WEB_PORT_MCP_MANAGER,
        container: process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME,
    };

    beforeEach(() => {
        fetchMock = jest
            .fn()
            .mockResolvedValue(new Response("ok", { status: 200 }));
        global.fetch = fetchMock as any;
        authMock.mockReset();
        authMock.mockResolvedValue({
            user: { accessToken: "server-session-token" },
        });
        process.env.WEB_HOSTNAME_MCP_MANAGER = "mcp.internal";
        process.env.WEB_PORT_MCP_MANAGER = "4040";
        delete process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    afterAll(() => {
        process.env.WEB_HOSTNAME_MCP_MANAGER = ENV_ORIG.host;
        process.env.WEB_PORT_MCP_MANAGER = ENV_ORIG.port;
        process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME = ENV_ORIG.container;
    });

    it("GET: rewrites to the internal MCP host + port", async () => {
        await GET(mockReq("GET", { search: "?page=1" }), ctx(["integrations"]));
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("http://mcp.internal:4040/integrations?page=1");
    });

    it("resolves localhost hostname to GLOBAL_MCP_MANAGER_CONTAINER_NAME", async () => {
        process.env.WEB_HOSTNAME_MCP_MANAGER = "localhost";
        process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME = "my-mcp-container";
        await GET(mockReq("GET"), ctx(["integrations"]));
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("http://my-mcp-container:4040/integrations");
    });

    it("falls back to kodus-mcp-manager when the container name env is unset", async () => {
        process.env.WEB_HOSTNAME_MCP_MANAGER = "localhost";
        delete process.env.GLOBAL_MCP_MANAGER_CONTAINER_NAME;
        await GET(mockReq("GET"), ctx(["integrations"]));
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("http://kodus-mcp-manager:4040/integrations");
    });

    it("injects Bearer token resolved server-side from NextAuth", async () => {
        await GET(mockReq("GET"), ctx(["integrations"]));
        const [, init] = fetchMock.mock.calls[0];
        expect((init.headers as Headers).get("authorization")).toBe(
            "Bearer server-session-token",
        );
    });

    it("omits Authorization when no active session", async () => {
        authMock.mockResolvedValueOnce(null);
        await GET(mockReq("GET"), ctx(["integrations"]));
        const [, init] = fetchMock.mock.calls[0];
        expect((init.headers as Headers).get("authorization")).toBeNull();
    });

    it("strips the incoming Host header", async () => {
        await GET(mockReq("GET"), ctx(["x"]));
        const [, init] = fetchMock.mock.calls[0];
        expect((init.headers as Headers).get("host")).toBeNull();
    });

    it("POST: forwards body stream with duplex", async () => {
        const body = new ReadableStream();
        await POST(mockReq("POST", { body }), ctx(["x"]));
        const [, init] = fetchMock.mock.calls[0];
        expect(init.body).toBe(body);
        expect((init as any).duplex).toBe("half");
    });
});
