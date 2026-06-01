import { apiProxyPath } from "./api-proxy";

describe("apiProxyPath", () => {
    it("prepends the proxy prefix to absolute paths", () => {
        expect(apiProxyPath("/issues/123")).toBe("/api/proxy/api/issues/123");
    });

    it("adds a leading slash if the caller omitted one", () => {
        expect(apiProxyPath("issues/123")).toBe("/api/proxy/api/issues/123");
    });

    it("preserves query strings", () => {
        expect(apiProxyPath("/issues?status=open")).toBe(
            "/api/proxy/api/issues?status=open",
        );
    });

    it("handles the root path", () => {
        expect(apiProxyPath("/")).toBe("/api/proxy/api/");
    });

    it("does NOT read any process.env value", () => {
        // Guard against future regressions that might re-introduce an env
        // read. apiProxyPath must stay pure so it can be safely bundled
        // into client components.
        const original = process.env.WEB_HOSTNAME_API;
        process.env.WEB_HOSTNAME_API = "SHOULD_NOT_AFFECT_RESULT";
        try {
            expect(apiProxyPath("/foo")).toBe("/api/proxy/api/foo");
        } finally {
            process.env.WEB_HOSTNAME_API = original;
        }
    });
});
