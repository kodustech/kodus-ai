describe("getApiPublicUrl", () => {
    const hadWindow = typeof (globalThis as any).window !== "undefined";
    const originalWindow = hadWindow ? (globalThis as any).window : undefined;
    const envOrig: Record<string, string | undefined> = {};

    beforeEach(() => {
        envOrig.API_URL = process.env.API_URL;
        envOrig.WEB_HOSTNAME_API = process.env.WEB_HOSTNAME_API;
        envOrig.WEB_PORT_API = process.env.WEB_PORT_API;
    });

    afterEach(() => {
        delete (globalThis as any).window;
        delete (globalThis as any).__KODUS_PUBLIC_CONFIG__;
        if (hadWindow) {
            (globalThis as any).window = originalWindow;
        }
        process.env.API_URL = envOrig.API_URL;
        process.env.WEB_HOSTNAME_API = envOrig.WEB_HOSTNAME_API;
        process.env.WEB_PORT_API = envOrig.WEB_PORT_API;
        jest.resetModules();
    });

    function loadGetApiPublicUrl(): string {
        let value = "";
        jest.isolateModules(() => {
            value = require("./api-public-url").getApiPublicUrl() as string;
        });
        return value;
    }

    describe("server side (no window)", () => {
        beforeEach(() => {
            delete (globalThis as any).window;
        });

        it("prefers API_URL (the public browser-reachable origin) over the in-cluster proxy host (#1903)", () => {
            delete process.env.WEB_HOSTNAME_API;
            process.env.API_URL = "https://api.example.com";
            expect(loadGetApiPublicUrl()).toBe("https://api.example.com");
        });

        it("strips a trailing slash from API_URL so callers can append paths (#1903)", () => {
            process.env.API_URL = "https://api.example.com/";
            expect(loadGetApiPublicUrl()).toBe("https://api.example.com");
        });

        it("falls back to WEB_HOSTNAME_API/WEB_PORT_API when API_URL is unset", () => {
            delete process.env.API_URL;
            process.env.WEB_HOSTNAME_API = "api.internal";
            process.env.WEB_PORT_API = "8080";
            expect(loadGetApiPublicUrl()).toBe("http://api.internal:8080");
        });

        it("returns empty when neither API_URL nor WEB_HOSTNAME_API is set", () => {
            delete process.env.API_URL;
            delete process.env.WEB_HOSTNAME_API;
            delete process.env.WEB_PORT_API;
            expect(loadGetApiPublicUrl()).toBe("");
        });
    });

    describe("client side (window present)", () => {
        beforeEach(() => {
            (globalThis as any).window = globalThis;
        });

        it("reads window.__KODUS_PUBLIC_CONFIG__.apiPublicUrl, ignoring server env", () => {
            process.env.API_URL = "https://should-not-win.example.com";
            (globalThis as any).__KODUS_PUBLIC_CONFIG__ = {
                apiPublicUrl: "https://client.api.example.com/",
            };
            expect(loadGetApiPublicUrl()).toBe("https://client.api.example.com");
        });
    });
});