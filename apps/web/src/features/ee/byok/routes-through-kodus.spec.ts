import { routesThroughKodus } from "./_utils";
import type { BYOKConfig } from "./_types";

const config = (routing: BYOKConfig["routing"]): BYOKConfig => ({
    version: 2,
    credentials: [
        { id: "cred-kodus", provider: "kodus" },
        { id: "cred-own", provider: "openai_compatible" },
    ] as BYOKConfig["credentials"],
    models: [
        { id: "m-kodus", credentialId: "cred-kodus", model: "deepseek-v4" },
        { id: "m-own", credentialId: "cred-own", model: "deepseek-v4p1" },
    ] as BYOKConfig["models"],
    routing,
});

describe("routesThroughKodus", () => {
    it("is false when Kodus is connected but the org default is the user's own model", () => {
        // The reported case: two Kodus models sit in the list, the org default
        // and the fallback are both on the user's own key, so an empty balance
        // pauses nothing.
        expect(
            routesThroughKodus(
                config({ defaultModelId: "m-own", fallbackModelId: "m-own" }),
            ),
        ).toBe(false);
    });

    it("is true when the org default is a Kodus model", () => {
        expect(routesThroughKodus(config({ defaultModelId: "m-kodus" }))).toBe(
            true,
        );
    });

    it("is true when only the fallback is a Kodus model", () => {
        expect(
            routesThroughKodus(
                config({ defaultModelId: "m-own", fallbackModelId: "m-kodus" }),
            ),
        ).toBe(true);
    });

    it("is true when only a per-task override reaches Kodus", () => {
        expect(
            routesThroughKodus(
                config({
                    defaultModelId: "m-own",
                    taskOverrides: { code_review: "m-kodus" } as any,
                }),
            ),
        ).toBe(true);
    });

    it("is false without routing, without config, and without a Kodus credential", () => {
        expect(routesThroughKodus(config(undefined))).toBe(false);
        expect(routesThroughKodus(null)).toBe(false);
        expect(routesThroughKodus(undefined)).toBe(false);
        expect(
            routesThroughKodus({
                version: 2,
                credentials: [
                    { id: "cred-own", provider: "openai_compatible" },
                ] as BYOKConfig["credentials"],
                models: [
                    { id: "m-own", credentialId: "cred-own", model: "x" },
                ] as BYOKConfig["models"],
                routing: { defaultModelId: "m-own" },
            }),
        ).toBe(false);
    });
});
