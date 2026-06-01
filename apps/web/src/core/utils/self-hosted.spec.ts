/**
 * Tests for the isSelfHosted dual-mode behavior. The runtime-config
 * migration removed WEB_NODE_ENV from next.config.js's env: block, so
 * module-scope client code has to read the value from the injected
 * window.__KODUS_PUBLIC_CONFIG__ instead of process.env. Regression:
 * clients were getting isSelfHosted=false in self-hosted deployments,
 * which broke branches like the onboarding trial skip.
 */

describe("isSelfHosted", () => {
    const ENV_ORIG = process.env.WEB_NODE_ENV;
    const hadWindow = typeof (globalThis as any).window !== "undefined";
    const originalWindow = hadWindow
        ? (globalThis as any).window
        : undefined;

    afterEach(() => {
        process.env.WEB_NODE_ENV = ENV_ORIG;
        if (hadWindow) {
            (globalThis as any).window = originalWindow;
        } else {
            delete (globalThis as any).window;
        }
        delete (globalThis as any).__KODUS_PUBLIC_CONFIG__;
        jest.resetModules();
    });

    function loadIsSelfHosted(): boolean {
        let value: boolean = false;
        jest.isolateModules(() => {
            value = require("./self-hosted").isSelfHosted;
        });
        return value;
    }

    describe("server side (no window)", () => {
        beforeEach(() => {
            delete (globalThis as any).window;
        });

        it("reads process.env.WEB_NODE_ENV", () => {
            process.env.WEB_NODE_ENV = "self-hosted";
            expect(loadIsSelfHosted()).toBe(true);
        });

        it("returns false when WEB_NODE_ENV is not self-hosted", () => {
            process.env.WEB_NODE_ENV = "development";
            expect(loadIsSelfHosted()).toBe(false);
        });

        it("ignores window.__KODUS_PUBLIC_CONFIG__ on server side", () => {
            process.env.WEB_NODE_ENV = "development";
            // Even if a stray global exists, server side must not use it
            (globalThis as any).__KODUS_PUBLIC_CONFIG__ = {
                nodeEnv: "self-hosted",
            };
            expect(loadIsSelfHosted()).toBe(false);
        });
    });

    describe("client side (window present)", () => {
        beforeEach(() => {
            (globalThis as any).window = globalThis;
        });

        it("reads window.__KODUS_PUBLIC_CONFIG__.nodeEnv", () => {
            (globalThis as any).__KODUS_PUBLIC_CONFIG__ = {
                nodeEnv: "self-hosted",
            };
            expect(loadIsSelfHosted()).toBe(true);
        });

        it("returns false when nodeEnv is not self-hosted", () => {
            (globalThis as any).__KODUS_PUBLIC_CONFIG__ = {
                nodeEnv: "development",
            };
            expect(loadIsSelfHosted()).toBe(false);
        });

        it("returns false when config global is missing (pre-hydration)", () => {
            delete (globalThis as any).__KODUS_PUBLIC_CONFIG__;
            expect(loadIsSelfHosted()).toBe(false);
        });

        it("ignores process.env.WEB_NODE_ENV on client side", () => {
            // Proves the regression fix: even if process.env has the
            // value (it doesn't in a real browser, but module-scope code
            // could still read it from a stale bundle), client must only
            // trust the window-injected value.
            process.env.WEB_NODE_ENV = "self-hosted";
            (globalThis as any).__KODUS_PUBLIC_CONFIG__ = {
                nodeEnv: "development",
            };
            expect(loadIsSelfHosted()).toBe(false);
        });
    });
});
