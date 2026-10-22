/**
 * Tests for the web-side feature gate adapter. The decision matrix
 * itself lives in `libs/feature-gate/domain/decision.ts` and is covered
 * by `test/unit/feature-gate/feature-gate.service.spec.ts`. Here we
 * only verify the web-specific wiring:
 *
 *   - cloud uses release track and PostHog; self-hosted uses BETA_FEATURES
 *   - "deny" decisions short-circuit before calling PostHog
 *   - missing WEB_POSTHOG_KEY retains the cloud compatibility fallback
 *   - the user-vs-organization identifier is selected correctly
 *   - PostHog and auth() failures degrade safely (return false)
 */

import type { SnapshotFeature } from "@libs/feature-gate/domain/snapshot.types";

import { isFeatureEnabled } from "./resolver";

const featureMock: { current: SnapshotFeature | undefined } = {
    current: undefined,
};

jest.mock("./snapshot", () => ({
    findFeature: () => featureMock.current,
    getSnapshot: () => ({
        schema_version: 1,
        generated_at: "2026-05-07T00:00:00.000Z",
        source: "manual",
        features: {},
    }),
}));

const authMock = jest.fn<
    Promise<{
        user?: { userId?: string; organizationId?: string };
    } | null>,
    []
>();

jest.mock("src/core/config/auth", () => ({
    auth: () => authMock(),
}));

const isFeatureEnabledMock = jest.fn<
    Promise<boolean>,
    [string, string, unknown]
>();
const shutdownMock = jest.fn<Promise<void>, []>().mockResolvedValue();

jest.mock("posthog-node", () => ({
    PostHog: jest.fn().mockImplementation(() => ({
        isFeatureEnabled: (...args: [string, string, unknown]) =>
            isFeatureEnabledMock(...args),
        shutdown: () => shutdownMock(),
    })),
}));

const baseFeature: SnapshotFeature = {
    name: "Test feature",
    stage: "general-availability",
    audience: ["cloud", "self-hosted"],
};

describe("isFeatureEnabled (web resolver)", () => {
    const ENV_KEY = "WEB_POSTHOG_KEY";
    const originalKey = process.env[ENV_KEY];
    const originalWebNodeEnv = process.env.WEB_NODE_ENV;
    const originalBetaFeatures = process.env.BETA_FEATURES;

    beforeEach(() => {
        featureMock.current = { ...baseFeature };
        authMock.mockReset();
        isFeatureEnabledMock.mockReset();
        shutdownMock.mockClear();
        process.env[ENV_KEY] = "phc-test";
        process.env.WEB_NODE_ENV = "production";
        delete process.env.BETA_FEATURES;
    });

    afterAll(() => {
        if (originalKey === undefined) {
            delete process.env[ENV_KEY];
        } else {
            process.env[ENV_KEY] = originalKey;
        }
        if (originalWebNodeEnv === undefined) delete process.env.WEB_NODE_ENV;
        else process.env.WEB_NODE_ENV = originalWebNodeEnv;
        if (originalBetaFeatures === undefined)
            delete process.env.BETA_FEATURES;
        else process.env.BETA_FEATURES = originalBetaFeatures;
    });

    it("denies (without calling PostHog) when the catalog audience excludes cloud", async () => {
        featureMock.current = {
            ...baseFeature,
            audience: ["self-hosted"],
        };

        const result = await isFeatureEnabled({ feature: "agent-review" });

        expect(result).toBe(false);
        expect(isFeatureEnabledMock).not.toHaveBeenCalled();
    });

    it("denies a beta feature for stable-track orgs before PostHog", async () => {
        featureMock.current = {
            ...baseFeature,
            stage: "beta",
        };

        const result = await isFeatureEnabled({
            feature: "agent-review",
            releaseTrack: "stable",
        });

        expect(result).toBe(false);
        expect(isFeatureEnabledMock).not.toHaveBeenCalled();
    });

    it("falls through permissively when WEB_POSTHOG_KEY is unset in cloud", async () => {
        delete process.env[ENV_KEY];

        const result = await isFeatureEnabled({ feature: "agent-review" });

        expect(result).toBe(true);
        expect(authMock).not.toHaveBeenCalled();
        expect(isFeatureEnabledMock).not.toHaveBeenCalled();
    });

    it("hides beta controls on self-hosted until BETA_FEATURES is enabled", async () => {
        process.env.WEB_NODE_ENV = "self-hosted";
        featureMock.current = { ...baseFeature, stage: "beta" };

        expect(
            await isFeatureEnabled({ feature: "conditional-pr-approval" }),
        ).toBe(false);
        process.env.BETA_FEATURES = "true";
        expect(
            await isFeatureEnabled({ feature: "conditional-pr-approval" }),
        ).toBe(true);
        expect(isFeatureEnabledMock).not.toHaveBeenCalled();
    });

    it("returns false when no auth payload is available", async () => {
        authMock.mockResolvedValue(null);

        const result = await isFeatureEnabled({ feature: "agent-review" });

        expect(result).toBe(false);
        expect(isFeatureEnabledMock).not.toHaveBeenCalled();
    });

    it("queries PostHog with the user id when identifier is 'user' (default)", async () => {
        authMock.mockResolvedValue({
            user: { userId: "user-42", organizationId: "org-9" },
        });
        isFeatureEnabledMock.mockResolvedValue(true);

        const result = await isFeatureEnabled({ feature: "agent-review" });

        expect(result).toBe(true);
        expect(isFeatureEnabledMock).toHaveBeenCalledWith(
            "agent-review",
            "user-42",
            { groups: { organization: "org-9" } },
        );
    });

    it("queries PostHog with the org id when identifier is 'organization'", async () => {
        authMock.mockResolvedValue({
            user: { userId: "user-42", organizationId: "org-9" },
        });
        isFeatureEnabledMock.mockResolvedValue(true);

        const result = await isFeatureEnabled({
            feature: "agent-review",
            identifier: "organization",
        });

        expect(result).toBe(true);
        expect(isFeatureEnabledMock).toHaveBeenCalledWith(
            "agent-review",
            "org-9",
            { groups: { organization: "org-9" } },
        );
    });

    it("returns false when PostHog says no", async () => {
        authMock.mockResolvedValue({
            user: { userId: "user-42", organizationId: "org-9" },
        });
        isFeatureEnabledMock.mockResolvedValue(false);

        const result = await isFeatureEnabled({ feature: "agent-review" });

        expect(result).toBe(false);
    });

    it("treats catalog misses as compat-pass and still queries PostHog", async () => {
        featureMock.current = undefined;
        authMock.mockResolvedValue({
            user: { userId: "user-42", organizationId: "org-9" },
        });
        isFeatureEnabledMock.mockResolvedValue(true);

        const result = await isFeatureEnabled({
            feature: "uncatalogued-flag",
        });

        expect(result).toBe(true);
        expect(isFeatureEnabledMock).toHaveBeenCalled();
    });

    it("returns false (and logs) when auth() throws", async () => {
        authMock.mockRejectedValue(new Error("auth boom"));
        const errSpy = jest.spyOn(console, "error").mockImplementation();

        const result = await isFeatureEnabled({ feature: "agent-review" });

        expect(result).toBe(false);
        errSpy.mockRestore();
    });
});
