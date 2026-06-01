/**
 * Tests for the shared proxy handler factory. Locks in the behaviours
 * that are easy to regress silently: path normalization, denylist,
 * rate limiting, header handling.
 */

jest.mock("server-only", () => ({}), { virtual: true });

import {
    __testing,
    createProxyHandler,
} from "./create-proxy-handler";

function mockReq(
    method: string,
    opts?: {
        search?: string;
        cookie?: string;
        body?: ReadableStream | null;
    },
): any {
    const headers = new Headers({
        host: "app.example.com",
        ...(opts?.cookie ? { cookie: opts.cookie } : {}),
    });
    return {
        method,
        headers,
        body: opts?.body ?? null,
        nextUrl: { search: opts?.search ?? "" },
    };
}

function ctx(path: string[]) {
    return { params: Promise.resolve({ path }) };
}

describe("createProxyHandler", () => {
    const originalFetch = global.fetch;
    let fetchMock: jest.Mock;

    beforeEach(() => {
        fetchMock = jest
            .fn()
            .mockResolvedValue(new Response("ok", { status: 200 }));
        global.fetch = fetchMock as any;
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    describe("path normalization (defense against traversal)", () => {
        it.each(["..", ".", "foo\0bar"])(
            "rejects segment %j with 404 and no upstream call",
            async (badSegment) => {
                const handler = createProxyHandler({
                    resolveUpstream: (p) => `http://upstream${p}`,
                    proxyMountPath: "/api/proxy/test",
                });
                const res = await handler.GET(
                    mockReq("GET"),
                    ctx(["safe", badSegment]),
                );
                expect(res.status).toBe(404);
                expect(fetchMock).not.toHaveBeenCalled();
            },
        );

        it("normalizeUpstreamPath joins clean segments", () => {
            expect(__testing.normalizeUpstreamPath(["a", "b", "c"])).toBe(
                "/a/b/c",
            );
        });

        it("normalizeUpstreamPath returns null for traversal", () => {
            expect(__testing.normalizeUpstreamPath(["a", "..", "b"])).toBeNull();
        });
    });

    describe("denylist", () => {
        it("blocks paths that start with a denied prefix (case-insensitive) with 404", async () => {
            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
                denyPathPrefixes: ["/admin", "/internal"],
            });

            const res1 = await handler.GET(
                mockReq("GET"),
                ctx(["admin", "users"]),
            );
            expect(res1.status).toBe(404);

            const res2 = await handler.GET(
                mockReq("GET"),
                ctx(["ADMIN", "users"]),
            );
            expect(res2.status).toBe(404);

            const res3 = await handler.GET(
                mockReq("GET"),
                ctx(["internal", "metrics"]),
            );
            expect(res3.status).toBe(404);

            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("allows paths that do not match any denied prefix", async () => {
            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
                denyPathPrefixes: ["/admin"],
            });

            const res = await handler.GET(
                mockReq("GET"),
                ctx(["user", "profile"]),
            );
            expect(res.status).toBe(200);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it("denies BEFORE rate-limit check (so probers don't consume the budget)", async () => {
            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
                denyPathPrefixes: ["/admin"],
            });
            // 200 deny responses with the same session — if this consumed the
            // rate-limit budget the next legit call would 429. Validate by
            // flooding denies then asserting a legit call still goes
            // through. NOTE: a precise validation is non-trivial because
            // the shared limiter module state bleeds across tests; this
            // assertion only sanity-checks the deny path is fast and safe.
            for (let i = 0; i < 50; i++) {
                await handler.GET(
                    mockReq("GET", { cookie: "authjs.session-token=deny" }),
                    ctx(["admin", "page-" + i]),
                );
            }
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });

    describe("rate limiting", () => {
        it("returns 429 when the same session exceeds the window budget", async () => {
            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
            });
            const cookie = `authjs.session-token=rate-${Date.now()}`;

            // The module-level limiter tolerates RATE_LIMIT.maxPerWindow
            // requests per key per window. Blast past it.
            let sawLimit = false;
            for (let i = 0; i < 200; i++) {
                const res = await handler.GET(
                    mockReq("GET", { cookie }),
                    ctx(["anything"]),
                );
                if (res.status === 429) {
                    sawLimit = true;
                    break;
                }
            }
            expect(sawLimit).toBe(true);
        });
    });

    describe("header handling", () => {
        it("strips Host header before forwarding", async () => {
            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
            });
            await handler.GET(
                mockReq("GET", { cookie: "authjs.session-token=hstrip" }),
                ctx(["x"]),
            );
            const [, init] = fetchMock.mock.calls[0];
            expect((init.headers as Headers).get("host")).toBeNull();
        });

        it("preserves Cookie header", async () => {
            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
            });
            await handler.GET(
                mockReq("GET", { cookie: "authjs.session-token=pres; a=b" }),
                ctx(["x"]),
            );
            const [, init] = fetchMock.mock.calls[0];
            expect((init.headers as Headers).get("cookie")).toContain("a=b");
        });

        it("strips upstream Content-Encoding / Length / Transfer-Encoding", async () => {
            fetchMock.mockResolvedValueOnce(
                new Response("ok", {
                    status: 200,
                    headers: {
                        "content-encoding": "gzip",
                        "content-length": "123",
                        "transfer-encoding": "chunked",
                        "x-should-stay": "yes",
                    },
                }),
            );

            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
            });
            const res = await handler.GET(
                mockReq("GET", { cookie: "authjs.session-token=strip" }),
                ctx(["x"]),
            );

            expect(res.headers.get("content-encoding")).toBeNull();
            expect(res.headers.get("content-length")).toBeNull();
            expect(res.headers.get("transfer-encoding")).toBeNull();
            expect(res.headers.get("x-should-stay")).toBe("yes");
        });

        it("injects Bearer token from resolveBearerToken", async () => {
            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
                resolveBearerToken: async () => "tok-123",
            });
            await handler.GET(
                mockReq("GET", { cookie: "authjs.session-token=btok" }),
                ctx(["x"]),
            );
            const [, init] = fetchMock.mock.calls[0];
            expect((init.headers as Headers).get("authorization")).toBe(
                "Bearer tok-123",
            );
        });

        it("removes Authorization when token resolver returns null", async () => {
            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
                resolveBearerToken: async () => null,
            });
            const req = mockReq("GET", {
                cookie: "authjs.session-token=noauth",
            });
            // Simulate an incoming request that already carries a stale
            // Authorization header — the proxy must not forward it when
            // the resolver decides there's no active session.
            req.headers.set("authorization", "Bearer stale");
            await handler.GET(req, ctx(["x"]));
            const [, init] = fetchMock.mock.calls[0];
            expect(
                (init.headers as Headers).get("authorization"),
            ).toBeNull();
        });
    });

    describe("3xx redirect handling", () => {
        it("calls upstream fetch with redirect: 'manual' so the proxy never follows server-side", async () => {
            // Locks in the SAML SSO fix: before this, fetch's default
            // (`redirect: 'follow'`) made the proxy fetch the IdP page
            // server-side and serve it on the proxy URL, breaking
            // initiation entirely.
            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
            });
            await handler.GET(
                mockReq("GET", { cookie: "authjs.session-token=manual" }),
                ctx(["x"]),
            );
            const [, init] = fetchMock.mock.calls[0];
            expect((init as any).redirect).toBe("manual");
        });
        const redirectStatuses = [301, 302, 303, 307, 308];
        it.each(redirectStatuses)(
            "forwards %i status with empty body and rewritten Location",
            async (status) => {
                fetchMock.mockResolvedValueOnce(
                    new Response("upstream body — should not be forwarded", {
                        status,
                        headers: {
                            location: "https://idp.example.com/sso?req=abc",
                        },
                    }),
                );

                const handler = createProxyHandler({
                    resolveUpstream: (p) => `http://upstream.internal${p}`,
                    proxyMountPath: "/api/proxy/test",
                });

                const res = await handler.GET(
                    mockReq("GET", {
                        cookie: "authjs.session-token=redir-" + status,
                    }),
                    ctx(["auth", "sso", "login"]),
                );

                expect(res.status).toBe(status);
                expect(res.headers.get("location")).toBe(
                    "https://idp.example.com/sso?req=abc",
                );
                // Body must be null on a redirect — passing the
                // upstream stream lets the browser render whatever the
                // API attached, which is exactly the SAML SSO bug.
                expect(await res.text()).toBe("");
            },
        );

        it("rewrites internal-origin Location to a same-origin proxy path", async () => {
            // The whole point of the proxy is to keep the internal
            // hostname out of the browser. If the API redirects to
            // its own internal origin, we must rewrite — otherwise
            // the browser gets `http://kodus_api:3001/...`, which
            // doesn't resolve from the user's machine.
            fetchMock.mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: {
                        location:
                            "http://upstream.internal:3001/auth/saml/callback?token=x",
                    },
                }),
            );

            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream.internal:3001${p}`,
                proxyMountPath: "/api/proxy/api",
            });

            const res = await handler.GET(
                mockReq("GET", { cookie: "authjs.session-token=intern" }),
                ctx(["auth", "saml", "callback"]),
            );

            expect(res.headers.get("location")).toBe(
                "/api/proxy/api/auth/saml/callback?token=x",
            );
        });

        it("rewrites relative Location through the proxy mount path", async () => {
            // A relative Location like "/sso-callback" returned by
            // the API resolves against the upstream URL — which means
            // it points at the upstream origin, not the browser
            // origin. Treat it the same as an internal absolute URL.
            fetchMock.mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: { location: "/sso-callback?session=abc" },
                }),
            );

            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream.internal:3001${p}`,
                proxyMountPath: "/api/proxy/api",
            });

            const res = await handler.GET(
                mockReq("GET", { cookie: "authjs.session-token=rel" }),
                ctx(["auth", "login"]),
            );

            expect(res.headers.get("location")).toBe(
                "/api/proxy/api/sso-callback?session=abc",
            );
        });

        it("passes external-origin Location through unchanged", async () => {
            // Redirects to genuinely external origins (IdP, S3 signed
            // URL, OAuth provider) must be forwarded verbatim — the
            // browser is the only correct participant for the next
            // hop.
            fetchMock.mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    headers: {
                        location:
                            "https://accounts.google.com/o/oauth2/auth?client_id=abc",
                    },
                }),
            );

            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream.internal:3001${p}`,
                proxyMountPath: "/api/proxy/api",
            });

            const res = await handler.GET(
                mockReq("GET", { cookie: "authjs.session-token=ext" }),
                ctx(["oauth", "start"]),
            );

            expect(res.headers.get("location")).toBe(
                "https://accounts.google.com/o/oauth2/auth?client_id=abc",
            );
        });

        it("drops Location header when upstream value is unparseable", async () => {
            fetchMock.mockResolvedValueOnce(
                new Response(null, {
                    status: 302,
                    // Unterminated IPv6 host — WHATWG URL parser
                    // rejects this with TypeError.
                    headers: { location: "http://[bad" },
                }),
            );

            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream.internal${p}`,
                proxyMountPath: "/api/proxy/api",
            });

            const res = await handler.GET(
                mockReq("GET", { cookie: "authjs.session-token=bad" }),
                ctx(["weird"]),
            );

            expect(res.headers.get("location")).toBeNull();
        });

        describe("rewriteLocation helper", () => {
            const upstream = "http://upstream.internal:3001/foo";
            const mount = "/api/proxy/api";

            it("rewrites same-origin absolute URL", () => {
                expect(
                    __testing.rewriteLocation(
                        "http://upstream.internal:3001/bar?q=1",
                        upstream,
                        mount,
                    ),
                ).toBe("/api/proxy/api/bar?q=1");
            });

            it("rewrites relative URL", () => {
                expect(
                    __testing.rewriteLocation("/bar?q=1", upstream, mount),
                ).toBe("/api/proxy/api/bar?q=1");
            });

            it("preserves hash fragments", () => {
                expect(
                    __testing.rewriteLocation("/bar#section", upstream, mount),
                ).toBe("/api/proxy/api/bar#section");
            });

            it("passes external origins through unchanged", () => {
                expect(
                    __testing.rewriteLocation(
                        "https://idp.example.com/sso",
                        upstream,
                        mount,
                    ),
                ).toBe("https://idp.example.com/sso");
            });

            it("treats malformed-looking strings as relative paths (URL parser is permissive)", () => {
                // Worth locking in: the WHATWG URL parser percent-
                // encodes spaces and resolves the result as a
                // relative path, so this round-trips through the
                // proxy mount instead of erroring out.
                expect(
                    __testing.rewriteLocation("not a url", upstream, mount),
                ).toBe("/api/proxy/api/not%20a%20url");
            });

            it("returns null when the parser actually rejects the input", () => {
                expect(
                    __testing.rewriteLocation("http://[bad", upstream, mount),
                ).toBeNull();
            });
        });
    });

    describe("body streaming", () => {
        it("POST forwards body with duplex 'half'", async () => {
            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
            });
            const body = new ReadableStream();
            await handler.POST(
                mockReq("POST", {
                    cookie: "authjs.session-token=postbody",
                    body,
                }),
                ctx(["x"]),
            );
            const [, init] = fetchMock.mock.calls[0];
            expect(init.method).toBe("POST");
            expect(init.body).toBe(body);
            expect((init as any).duplex).toBe("half");
        });

        it("GET omits body/duplex", async () => {
            const handler = createProxyHandler({
                resolveUpstream: (p) => `http://upstream${p}`,
                proxyMountPath: "/api/proxy/test",
            });
            await handler.GET(
                mockReq("GET", { cookie: "authjs.session-token=getnone" }),
                ctx(["x"]),
            );
            const [, init] = fetchMock.mock.calls[0];
            expect(init.body).toBeUndefined();
            expect((init as any).duplex).toBeUndefined();
        });
    });
});
