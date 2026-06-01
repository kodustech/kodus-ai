/**
 * /api/proxy/api/[...path]/route.ts — forwards browser fetches to the
 * upstream backend. These tests lock in the forwarding semantics that
 * the client code depends on.
 */

jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("src/core/utils/helpers", () => ({
    pathToApiUrl: (p: string) => `http://upstream.internal:3001${p}`,
}));

const authMock = jest.fn();
jest.mock("src/core/config/auth", () => ({
    auth: () => authMock(),
}));

import { GET, POST, PATCH, PUT, DELETE } from "./[...path]/route";

function mockReq(
    method: string,
    path: string,
    init?: {
        headers?: Record<string, string>;
        search?: string;
        body?: ReadableStream | null;
    },
): any {
    const headers = new Headers({
        host: "app.example.com",
        cookie: "auth=abc",
        "content-type": "application/json",
        ...init?.headers,
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

describe("/api/proxy/api/[...path]", () => {
    const originalFetch = global.fetch;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        fetchMock = jest.fn().mockResolvedValue(
            new Response("upstream body", {
                status: 200,
                headers: { "x-upstream": "yes" },
            }),
        );
        global.fetch = fetchMock as any;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it("GET: rewrites path + query to upstream URL", async () => {
        const res = await GET(
            mockReq("GET", "/issues", { search: "?status=open" }),
            ctx(["issues"]),
        );
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("http://upstream.internal:3001/issues?status=open");
        expect(init.method).toBe("GET");
        expect(res.status).toBe(200);
    });

    it("strips the Host header so upstream sees its own vhost", async () => {
        await GET(mockReq("GET", "/x"), ctx(["x"]));
        const [, init] = fetchMock.mock.calls[0];
        expect((init.headers as Headers).get("host")).toBeNull();
    });

    it("preserves Cookie and Content-Type headers", async () => {
        await GET(mockReq("GET", "/x"), ctx(["x"]));
        const [, init] = fetchMock.mock.calls[0];
        const h = init.headers as Headers;
        expect(h.get("cookie")).toBe("auth=abc");
        expect(h.get("content-type")).toBe("application/json");
    });

    it("POST: streams request body with duplex: 'half'", async () => {
        const body = new ReadableStream();
        await POST(mockReq("POST", "/x", { body }), ctx(["x"]));
        const [, init] = fetchMock.mock.calls[0];
        expect(init.method).toBe("POST");
        expect(init.body).toBe(body);
        expect((init as any).duplex).toBe("half");
    });

    it("GET: does NOT set body or duplex (would break GET semantics)", async () => {
        await GET(mockReq("GET", "/x"), ctx(["x"]));
        const [, init] = fetchMock.mock.calls[0];
        expect(init.body).toBeUndefined();
        expect((init as any).duplex).toBeUndefined();
    });

    it("passes through upstream status code", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response("not found", { status: 404 }),
        );
        const res = await GET(mockReq("GET", "/missing"), ctx(["missing"]));
        expect(res.status).toBe(404);
    });

    it("joins nested path segments", async () => {
        await GET(mockReq("GET", "/a/b/c"), ctx(["a", "b", "c"]));
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe("http://upstream.internal:3001/a/b/c");
    });

    it("handles PUT / PATCH / DELETE", async () => {
        await PUT(mockReq("PUT", "/x"), ctx(["x"]));
        await PATCH(mockReq("PATCH", "/x"), ctx(["x"]));
        await DELETE(mockReq("DELETE", "/x"), ctx(["x"]));
        const methods = fetchMock.mock.calls.map((c) => c[1].method);
        expect(methods).toEqual(["PUT", "PATCH", "DELETE"]);
    });
});
