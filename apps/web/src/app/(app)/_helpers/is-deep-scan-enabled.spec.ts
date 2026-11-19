import { isFeatureEnabled } from "src/core/feature-gate/resolver";

import { isDeepScanEnabled } from "./get-layout-data";

jest.mock("react", () => ({
    ...jest.requireActual("react"),
    // No request scope here: each call evaluates afresh.
    cache: (fn: unknown) => fn,
}));
jest.mock("src/core/config/auth", () => ({
    auth: jest.fn(async () => ({ user: { organizationId: "org-1" } })),
}));
jest.mock("src/core/feature-gate/resolver", () => ({
    isFeatureEnabled: jest.fn(async () => false),
}));
jest.mock("@services/organizations/release-track", () => ({
    getOrganizationReleaseTrack: jest.fn(async () => "beta"),
}));
jest.mock("@services/organizationParameters/fetch", () => ({}));
jest.mock("@services/organizations/fetch", () => ({}));
jest.mock("@services/permissions/fetch", () => ({}));
jest.mock("@services/teams/fetch", () => ({}));
jest.mock("src/features/ee/subscription/_utils/held-seats", () => ({}));

describe("isDeepScanEnabled", () => {
    const previous = { ...process.env };
    afterEach(() => {
        process.env = { ...previous };
    });

    it("opens the page for an organization the API's allow-list opens", async () => {
        process.env.API_DEEP_SCAN_ALPHA_ORGS = "*";
        await expect(isDeepScanEnabled()).resolves.toBe(true);

        process.env.API_DEEP_SCAN_ALPHA_ORGS = "org-2, org-1";
        await expect(isDeepScanEnabled()).resolves.toBe(true);
    });

    it("stays closed outside cloud mode, as the API's gate does, even on the allow-list", async () => {
        process.env.API_DEEP_SCAN_ALPHA_ORGS = "*";
        process.env.API_CLOUD_MODE = "false";
        await expect(isDeepScanEnabled()).resolves.toBe(false);

        process.env.API_CLOUD_MODE = "true";
        process.env.WEB_NODE_ENV = "self-hosted";
        await expect(isDeepScanEnabled()).resolves.toBe(false);
    });

    it("falls back to the release gate for anyone else", async () => {
        process.env.API_DEEP_SCAN_ALPHA_ORGS = "org-2";
        await expect(isDeepScanEnabled()).resolves.toBe(false);
        expect(isFeatureEnabled).toHaveBeenCalled();
    });
});
