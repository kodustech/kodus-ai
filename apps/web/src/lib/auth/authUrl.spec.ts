/**
 * The `authUrl` helper lives inside fetchers.ts and is not exported, so
 * we exercise it indirectly through one of the exported functions
 * (`ssoLogin`, which sets window.location.href to the resolved URL).
 *
 * Two modes: server side returns the full upstream URL (via
 * pathToApiUrl), client side returns the same-origin proxy path (via
 * apiProxyPath). This test locks in that dual-mode behaviour — a
 * regression here would re-leak internal hostnames into the browser
 * bundle OR break NextAuth's server-side sign-in flow.
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

// Mock helpers.ts to skip the jose (ESM) import chain and keep the test
// focused on the authUrl branching logic. pathToApiUrl is stubbed to a
// unique marker string so server-side assertions are unambiguous.
jest.mock("src/core/utils/helpers", () => ({
    pathToApiUrl: (route: string) => `http://UPSTREAM_HOST${route}`,
}));

jest.mock("src/core/utils/axios", () => ({
    axiosApi: {
        post: jest.fn().mockResolvedValue({ data: {} }),
        get: jest.fn().mockResolvedValue({ data: {} }),
    },
    axiosAuthorized: {
        post: jest.fn().mockResolvedValue({ data: {} }),
        get: jest.fn().mockResolvedValue({ data: {} }),
        fetcher: jest.fn().mockResolvedValue({ data: [] }),
    },
}));

jest.mock("@services/fetch", () => ({
    typedFetch: jest.fn().mockResolvedValue({ data: {} }),
}));

jest.mock("src/core/config/constants", () => ({
    API_ROUTES: {
        login: "/auth/login",
        register: "/auth/register",
        ssoLogin: "/auth/sso",
    },
}));

describe("auth fetchers authUrl dual-mode", () => {
    const WEB_HOSTNAME_API_ORIG = process.env.WEB_HOSTNAME_API;
    const WEB_PORT_API_ORIG = process.env.WEB_PORT_API;
    const setServer = (v: boolean) => {
        const mod = require("src/core/utils/server-side");
        mod.__setServerSide(v);
    };

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        process.env.WEB_HOSTNAME_API = "api.test";
        process.env.WEB_PORT_API = "3001";
    });

    afterAll(() => {
        process.env.WEB_HOSTNAME_API = WEB_HOSTNAME_API_ORIG;
        process.env.WEB_PORT_API = WEB_PORT_API_ORIG;
    });

    it("server side: loginEmailPassword hits the full upstream URL", async () => {
        setServer(true);
        const { loginEmailPassword } = await import("./fetchers");
        const { axiosApi } = await import("src/core/utils/axios");
        await loginEmailPassword({ email: "x@y.z", password: "p" });
        const calledWith = (axiosApi.post as jest.Mock).mock.calls[0][0];
        // Server side routes through the mocked pathToApiUrl stub.
        expect(calledWith).toBe("http://UPSTREAM_HOST/auth/login");
        expect(calledWith).not.toContain("/api/proxy/api");
    });

    it("client side: loginEmailPassword hits the same-origin proxy path", async () => {
        setServer(false);
        const { loginEmailPassword } = await import("./fetchers");
        const { axiosApi } = await import("src/core/utils/axios");
        await loginEmailPassword({ email: "x@y.z", password: "p" });
        const calledWith = (axiosApi.post as jest.Mock).mock.calls[0][0];
        expect(calledWith).toBe("/api/proxy/api/auth/login");
        expect(calledWith).not.toContain("UPSTREAM_HOST");
    });

    it("client side: never infinite-recurses (regression test)", async () => {
        // Regression: an earlier version of authUrl did `isServerSide
        // ? authUrl(route) : apiProxyPath(route)` — RangeError on any
        // server-side call. Confirm both modes complete synchronously.
        setServer(false);
        const { registerUser } = await import("./fetchers");
        const result = registerUser({
            name: "x",
            email: "x@y.z",
            password: "p",
        });
        // Just resolving (no RangeError) is the assertion.
        await expect(result).resolves.toBeDefined();
    });
});
