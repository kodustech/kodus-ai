/**
 * billingFetch is dual-mode:
 *   - Server side: direct to internal billing host.
 *   - Client side: through /api/proxy/billing/<path>.
 *
 * Same contract as mcp-manager/utils: keeps internal hostnames out of
 * the client bundle without breaking server-side usage.
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

const typedFetchMock = jest.fn();
jest.mock("@services/fetch", () => ({
    typedFetch: (...args: unknown[]) => typedFetchMock(...args),
}));

const setServer = (v: boolean) => {
    const mod = require("src/core/utils/server-side");
    mod.__setServerSide(v);
};

describe("billingFetch dual-mode", () => {
    const ORIG_HOST = process.env.WEB_HOSTNAME_BILLING;
    const ORIG_PORT = process.env.WEB_PORT_BILLING;

    beforeEach(() => {
        jest.resetModules();
        createUrlMock.mockClear();
        typedFetchMock.mockReset();
        typedFetchMock.mockResolvedValue({ ok: true });
        process.env.WEB_HOSTNAME_BILLING = "billing.internal";
        process.env.WEB_PORT_BILLING = "3992";
    });

    afterAll(() => {
        process.env.WEB_HOSTNAME_BILLING = ORIG_HOST;
        process.env.WEB_PORT_BILLING = ORIG_PORT;
    });

    it("server side: hits internal host with /api/billing/ prefix", async () => {
        setServer(true);
        const { billingFetch } = await import("./utils");
        await billingFetch("license/users");
        const [url] = typedFetchMock.mock.calls[0];
        expect(url).toBe(
            "http://billing.internal:3992/api/billing/license/users",
        );
    });

    it("client side: goes through /api/proxy/billing", async () => {
        setServer(false);
        const { billingFetch } = await import("./utils");
        await billingFetch("/license/users");
        const [url] = typedFetchMock.mock.calls[0];
        expect(url).toBe("/api/proxy/billing/license/users");
    });

    it("client side: no internal hostname leaks in the URL", async () => {
        setServer(false);
        const { billingFetch } = await import("./utils");
        await billingFetch("/license/users");
        const [url] = typedFetchMock.mock.calls[0];
        expect(url).not.toContain("billing.internal");
        expect(url).not.toContain("3992");
    });

    // Regression: the server-side billingFetch must flag its
    // createUrl call as internal so the http+port branch fires. Before
    // the explicit `{ internal: true }` flag existed this relied on a
    // containerName trick; without either signal the helper returned
    // https://<host> with no port and ECONNREFUSED'd at 443 under
    // WEB_NODE_ENV=self-hosted.
    it("server side: flags createUrl as internal (localhost-resolved host)", async () => {
        setServer(true);
        process.env.WEB_HOSTNAME_BILLING = "localhost";
        process.env.GLOBAL_BILLING_CONTAINER_NAME = "my-billing";
        const { billingFetch } = await import("./utils");
        await billingFetch("trial");
        const [, , , options] = createUrlMock.mock.calls[0];
        expect(options).toEqual({ internal: true });
        delete process.env.GLOBAL_BILLING_CONTAINER_NAME;
    });

    it("server side: flags createUrl as internal (direct hostname)", async () => {
        setServer(true);
        process.env.WEB_HOSTNAME_BILLING = "billing.customer.com";
        const { billingFetch } = await import("./utils");
        await billingFetch("plans");
        const [, , , options] = createUrlMock.mock.calls[0];
        expect(options).toEqual({ internal: true });
    });
});

/**
 * The signature on billing's money routes must cover the request that is
 * actually sent — the query `typedFetch` appends from `params`, and the body
 * bytes. Signing one thing and sending another answers 401, and `billingFetch`
 * turns that into a silent `null`.
 */
describe("billingFetch signs what it sends", () => {
    const SECRET = "shared-webhook-secret";
    const ORIG = {
        host: process.env.WEB_HOSTNAME_BILLING,
        port: process.env.WEB_PORT_BILLING,
        webhook: process.env.API_BILLING_WEBHOOK_SECRET,
        dedicated: process.env.API_CREDITS_SERVICE_TOKEN,
    };

    beforeEach(() => {
        jest.resetModules();
        createUrlMock.mockClear();
        typedFetchMock.mockReset();
        typedFetchMock.mockResolvedValue({ ok: true });
        process.env.WEB_HOSTNAME_BILLING = "billing.internal";
        process.env.WEB_PORT_BILLING = "3992";
        process.env.API_BILLING_WEBHOOK_SECRET = SECRET;
        delete process.env.API_CREDITS_SERVICE_TOKEN;
        setServer(true);
    });

    afterAll(() => {
        process.env.WEB_HOSTNAME_BILLING = ORIG.host;
        process.env.WEB_PORT_BILLING = ORIG.port;
        if (ORIG.webhook === undefined)
            delete process.env.API_BILLING_WEBHOOK_SECRET;
        else process.env.API_BILLING_WEBHOOK_SECRET = ORIG.webhook;
        if (ORIG.dedicated === undefined)
            delete process.env.API_CREDITS_SERVICE_TOKEN;
        else process.env.API_CREDITS_SERVICE_TOKEN = ORIG.dedicated;
    });

    const expectedSignature = async (
        method: string,
        signedPath: string,
        rawBody: string,
        timestamp: string,
    ) => {
        const { billingSignaturePayload } = await import("./signature");
        const { createHmac } = await import("crypto");
        return createHmac("sha256", SECRET)
            .update(
                billingSignaturePayload(method, signedPath, timestamp, rawBody),
            )
            .digest("hex");
    };

    it("covers the params typedFetch will append to the URL", async () => {
        const { billingFetch } = await import("./utils");
        await billingFetch("credits/balance", {
            method: "GET",
            params: { organizationId: "org-1", teamId: "team-9" },
        } as never);
        const [, config] = typedFetchMock.mock.calls[0];
        const timestamp = config.headers["x-kodus-timestamp"];
        expect(timestamp).toMatch(/^\d+$/);
        expect(config.headers["x-kodus-signature"]).toBe(
            await expectedSignature(
                "GET",
                "credits/balance?organizationId=org-1&teamId=team-9",
                "",
                timestamp,
            ),
        );
    });

    it("serializes a non-string body and sends the bytes it signed", async () => {
        const { billingFetch } = await import("./utils");
        const body = { organizationId: "org-1", creditUsd: 20 };
        await billingFetch("credits/checkout", {
            method: "POST",
            body,
        } as never);
        const [, config] = typedFetchMock.mock.calls[0];
        // The config that reaches fetch carries the serialized string, not the
        // object — otherwise `fetch` would send "[object Object]".
        expect(config.body).toBe(JSON.stringify(body));
        expect(config.headers["x-kodus-signature"]).toBe(
            await expectedSignature(
                "POST",
                "credits/checkout",
                JSON.stringify(body),
                config.headers["x-kodus-timestamp"],
            ),
        );
    });

    it("passes a form body through untouched, and unsigned, on an unsigned route", async () => {
        const { billingFetch } = await import("./utils");
        const form = new URLSearchParams({ a: "1" });
        await billingFetch("plans", { method: "POST", body: form } as never);
        const [, config] = typedFetchMock.mock.calls[0];
        // Not replaced by "{}" — the payload survives.
        expect(config.body).toBe(form);
        // And no signature: one over "" would claim to cover bytes it never saw.
        expect(config.headers?.["x-kodus-signature"]).toBeUndefined();
    });

    it("serializes anything JSON can represent, including a class instance", async () => {
        const { billingFetch } = await import("./utils");
        class DebitRequest {
            constructor(
                public organizationId: string,
                public creditUsd: number,
            ) {}
        }
        const dto = new DebitRequest("org-1", 20);
        await billingFetch("credits/checkout", {
            method: "POST",
            body: dto,
        } as never);
        const [, config] = typedFetchMock.mock.calls[0];
        expect(config.body).toBe(JSON.stringify(dto));
        expect(config.headers["x-kodus-signature"]).toBe(
            await expectedSignature(
                "POST",
                "credits/checkout",
                JSON.stringify(dto),
                config.headers["x-kodus-timestamp"],
            ),
        );
    });

    it("refuses a body it cannot sign on a credit route", async () => {
        const { billingFetch } = await import("./utils");
        await expect(
            billingFetch("credits/checkout", {
                method: "POST",
                body: new URLSearchParams({ creditUsd: "20" }),
            } as never),
        ).rejects.toThrow(/cannot be signed/);
        expect(typedFetchMock).not.toHaveBeenCalled();
    });

    it("says so, loudly, when no secret is configured", async () => {
        delete process.env.API_BILLING_WEBHOOK_SECRET;
        const error = jest
            .spyOn(console, "error")
            .mockImplementation(() => undefined);
        const { billingFetch } = await import("./utils");
        await billingFetch("credits/balance", {
            method: "GET",
            params: { organizationId: "org-1" },
        } as never);
        const [, config] = typedFetchMock.mock.calls[0];
        expect(config?.headers?.["x-kodus-signature"]).toBeUndefined();
        expect(error).toHaveBeenCalledWith(
            expect.stringContaining("API_BILLING_WEBHOOK_SECRET"),
            expect.objectContaining({ method: "GET" }),
        );
        error.mockRestore();
    });
});
