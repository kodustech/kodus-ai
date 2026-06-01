/**
 * Tests for createUrl — specifically the self-hosted branch that caused
 * the billing proxy ECONNREFUSED regression.
 *
 * The function's self-hosted branch picks "https + no port" whenever the
 * resolved hostname differs from a default containerName that points at
 * the API container. Passing { containerName: hostName } is the escape
 * hatch so non-API upstreams (billing, MCP) keep the http + port
 * behavior. These tests lock both branches in.
 */

jest.mock("server-only", () => ({}), { virtual: true });
// helpers.ts imports jose (ESM) for JWT utilities and a deep type from
// the (app) tree. createUrl doesn't touch either, so stub them to keep
// the test hermetic.
jest.mock("jose", () => ({
    decodeJwt: jest.fn(),
    decodeProtectedHeader: jest.fn(),
}));
jest.mock(
    "src/app/(app)/settings/code-review/_types",
    () => ({}),
    { virtual: true },
);

describe("createUrl", () => {
    const ENV_ORIG = {
        webNodeEnv: process.env.WEB_NODE_ENV,
        apiContainer: process.env.GLOBAL_API_CONTAINER_NAME,
    };

    afterEach(() => {
        process.env.WEB_NODE_ENV = ENV_ORIG.webNodeEnv;
        process.env.GLOBAL_API_CONTAINER_NAME = ENV_ORIG.apiContainer;
        jest.resetModules();
    });

    function loadCreateUrl(env: {
        nodeEnv?: string;
        apiContainer?: string;
    }): typeof import("./helpers").createUrl {
        if (env.nodeEnv !== undefined) {
            process.env.WEB_NODE_ENV = env.nodeEnv;
        } else {
            delete process.env.WEB_NODE_ENV;
        }
        if (env.apiContainer !== undefined) {
            process.env.GLOBAL_API_CONTAINER_NAME = env.apiContainer;
        } else {
            delete process.env.GLOBAL_API_CONTAINER_NAME;
        }
        let mod: typeof import("./helpers");
        jest.isolateModules(() => {
            mod = require("./helpers");
        });
        return mod!.createUrl;
    }

    describe("{ internal: true } — explicit intra-network hop", () => {
        it("self-hosted billing container: http + port", () => {
            const createUrl = loadCreateUrl({ nodeEnv: "self-hosted" });
            const url = createUrl(
                "kodus-service-billing",
                "3992",
                "/api/billing/trial",
                { internal: true },
            );
            expect(url).toBe(
                "http://kodus-service-billing:3992/api/billing/trial",
            );
        });

        it("production with internal flag still http + port (no heuristic override)", () => {
            const createUrl = loadCreateUrl({ nodeEnv: "production" });
            expect(
                createUrl("kodus_api", "3001", "/team", { internal: true }),
            ).toBe("http://kodus_api:3001/team");
        });

        it("explicit https:// scheme in hostName beats the internal default", () => {
            const createUrl = loadCreateUrl({ nodeEnv: "self-hosted" });
            expect(
                createUrl("https://api.internal", "8443", "/x", {
                    internal: true,
                }),
            ).toBe("https://api.internal:8443/x");
        });

        // Regression repro for the QA/prod AWS outage on 2026-04-28: every
        // /api/proxy/* route hardcodes `internal: true`, but when the env
        // points at a public ALB-fronted domain there's no WEB_PORT_*. We
        // must NOT produce `http://<host>/path` (port 80, plain HTTP) —
        // the ALB only listens on 443 with TLS termination, so the
        // upstream rejects with ECONNREFUSED. With no port, the call has
        // to fall through to the public-URL heuristic (https + no port).
        it("production with internal flag and NO port → https, no port (AWS ALB)", () => {
            const createUrl = loadCreateUrl({ nodeEnv: "production" });
            expect(
                createUrl("qa.api.kodus.io", undefined, "/user/email", {
                    internal: true,
                }),
            ).toBe("https://qa.api.kodus.io/user/email");
        });

        it("self-hosted with internal flag and NO port → https, no port (customer domain)", () => {
            const createUrl = loadCreateUrl({ nodeEnv: "self-hosted" });
            expect(
                createUrl("api.cliente.com", undefined, "/x", {
                    internal: true,
                }),
            ).toBe("https://api.cliente.com/x");
        });
    });

    describe("legacy heuristic (no `internal` flag) — kept for back-compat", () => {
        it("regression repro: in self-hosted with no flag, billing host leaks to https/no-port", () => {
            const createUrl = loadCreateUrl({ nodeEnv: "self-hosted" });
            expect(
                createUrl(
                    "kodus-service-billing",
                    "3992",
                    "/api/billing/trial",
                ),
            ).toBe("https://kodus-service-billing/api/billing/trial");
        });

        it("localhost stays http + port even without a flag", () => {
            const createUrl = loadCreateUrl({ nodeEnv: "self-hosted" });
            expect(createUrl("localhost", "3001", "/x")).toBe(
                "http://localhost:3001/x",
            );
        });

        it("development: http + port for any host", () => {
            const createUrl = loadCreateUrl({ nodeEnv: "development" });
            expect(createUrl("anything", "1234", "/p")).toBe(
                "http://anything:1234/p",
            );
        });

        it("production: https, no port (public-facing default)", () => {
            const createUrl = loadCreateUrl({ nodeEnv: "production" });
            expect(createUrl("api.example.com", "443", "/p")).toBe(
                "https://api.example.com/p",
            );
        });
    });

    describe("protocol detection from hostName", () => {
        it("preserves http:// prefix", () => {
            const createUrl = loadCreateUrl({ nodeEnv: "development" });
            expect(createUrl("http://host", "80", "/p")).toBe(
                "http://host:80/p",
            );
        });

        it("preserves https:// prefix", () => {
            const createUrl = loadCreateUrl({ nodeEnv: "development" });
            expect(createUrl("https://host", "443", "/p")).toBe(
                "https://host:443/p",
            );
        });
    });
});
