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

import { isFeatureEnabled } from "src/core/feature-gate/resolver";

import { isDeepScanEnabled } from "./get-layout-data";

describe("isDeepScanEnabled", () => {
    const previous = process.env.API_DEEP_SCAN_ALPHA_ORGS;
    afterEach(() => {
        process.env.API_DEEP_SCAN_ALPHA_ORGS = previous;
    });

    it("opens the page for an organization the API's allow-list opens", async () => {
        process.env.API_DEEP_SCAN_ALPHA_ORGS = "*";
        await expect(isDeepScanEnabled()).resolves.toBe(true);

        process.env.API_DEEP_SCAN_ALPHA_ORGS = "org-2, org-1";
        await expect(isDeepScanEnabled()).resolves.toBe(true);
    });

    it("falls back to the release gate for anyone else", async () => {
        process.env.API_DEEP_SCAN_ALPHA_ORGS = "org-2";
        await expect(isDeepScanEnabled()).resolves.toBe(false);
        expect(isFeatureEnabled).toHaveBeenCalled();
    });
});
