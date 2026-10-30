import type { BYOKConfig, BYOKCredential } from "../_types";
import { pickProbeModel } from "./pick-probe-model";

/**
 * The probe model decides what "Test" means, and the rotate screen refuses to
 * save when the probe fails — so picking it by array order made a key rotation
 * hostage to whichever model happened to be stored first.
 */
const cred = (id: string): BYOKCredential =>
    ({ id, provider: "open_router", apiKey: "x" }) as BYOKCredential;

const config = (
    models: Array<{ id: string; credentialId: string; model: string }>,
    routing?: Record<string, unknown>,
): BYOKConfig =>
    ({
        version: 2,
        credentials: [cred("cred-main"), cred("cred-other")],
        models,
        routing: routing ?? {},
    }) as BYOKConfig;

const MINE = [
    {
        id: "model-first",
        credentialId: "cred-main",
        model: "deepseek/deepseek-v4-pro",
    },
    {
        id: "model-default",
        credentialId: "cred-main",
        model: "z-ai/glm-5.3-flash",
    },
    { id: "model-fallback", credentialId: "cred-main", model: "openai/gpt-5" },
];

describe("pickProbeModel", () => {
    it("probes the model routing actually runs, not the first stored", () => {
        const picked = pickProbeModel(
            config(MINE, { defaultModelId: "model-default" }),
            cred("cred-main"),
        );

        expect(picked).toBe("z-ai/glm-5.3-flash");
    });

    it("falls back to the routing fallback when there is no default", () => {
        const picked = pickProbeModel(
            config(MINE, { fallbackModelId: "model-fallback" }),
            cred("cred-main"),
        );

        expect(picked).toBe("openai/gpt-5");
    });

    it("prefers the default over the fallback", () => {
        const picked = pickProbeModel(
            config(MINE, {
                defaultModelId: "model-default",
                fallbackModelId: "model-fallback",
            }),
            cred("cred-main"),
        );

        expect(picked).toBe("z-ai/glm-5.3-flash");
    });

    it("ignores a routing default that belongs to ANOTHER credential", () => {
        // Testing another provider's model would report on a different key —
        // a pass or a failure that says nothing about the one being rotated.
        const picked = pickProbeModel(
            config(
                [
                    ...MINE,
                    {
                        id: "model-elsewhere",
                        credentialId: "cred-other",
                        model: "anthropic/claude",
                    },
                ],
                { defaultModelId: "model-elsewhere" },
            ),
            cred("cred-main"),
        );

        expect(picked).toBe("deepseek/deepseek-v4-pro");
    });

    it("still returns something when routing names nothing", () => {
        // Array order is the last resort, not the rule — a credential with no
        // routing reference must remain testable.
        expect(pickProbeModel(config(MINE), cred("cred-main"))).toBe(
            "deepseek/deepseek-v4-pro",
        );
    });

    it.each([
        ["a credential with no models", []],
        [
            "only another credential's models",
            [{ id: "m", credentialId: "cred-other", model: "x" }],
        ],
    ])("returns undefined for %s", (_label, models) => {
        expect(
            pickProbeModel(config(models as never), cred("cred-main")),
        ).toBeUndefined();
    });

    it("returns undefined with no credential", () => {
        expect(pickProbeModel(config(MINE), undefined)).toBeUndefined();
    });
});
