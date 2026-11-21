import { getOrganizationReleaseTrack } from "@services/organizations/release-track";
import { isFeatureEnabled } from "src/core/feature-gate/resolver";

import { getLayoutData } from "./get-layout-data";

jest.mock("react", () => ({ ...jest.requireActual("react"), cache: (fn: unknown) => fn }));
// The deep scan's gate reads the session; next-auth is ESM and never loads here.
jest.mock("src/core/config/auth", () => ({ auth: jest.fn(async () => null) }));
jest.mock("@services/organizationParameters/fetch", () => ({ getLLMConfigStatus: jest.fn(async () => ({})) }));
jest.mock("@services/organizations/fetch", () => ({ getOrganizationName: jest.fn(async () => "Org") }));
jest.mock("@services/organizations/release-track", () => ({ getOrganizationReleaseTrack: jest.fn() }));
jest.mock("@services/permissions/fetch", () => ({ getPermissions: jest.fn(async () => ({})) }));
jest.mock("@services/teams/fetch", () => ({ getTeams: jest.fn(async () => []) }));
jest.mock("src/core/feature-gate/resolver", () => ({ isFeatureEnabled: jest.fn(async () => false) }));
jest.mock("src/features/ee/subscription/_services/billing/fetch", () => ({
    getUsersWithLicense: jest.fn(async () => []),
    validateOrganizationLicense: jest.fn(async () => ({})),
}));
jest.mock("src/features/ee/subscription/_utils/held-seats", () => ({ heldSeats: jest.fn(() => 0) }));

describe("the app layout's Kody Runtime flag", () => {
    beforeEach(() => jest.clearAllMocks());

    it.each([
        ["alpha", true],
        ["beta", false],
        ["stable", false],
    ])("comes from the org's release track: %s is %s, without asking the flag resolver", async (track, shown) => {
        (getOrganizationReleaseTrack as jest.Mock).mockResolvedValue(track);
        const data = await getLayoutData("team-1");
        expect(data.featureFlags.kodyRuntime).toBe(shown);
        expect(isFeatureEnabled).not.toHaveBeenCalledWith(expect.objectContaining({ feature: "kody-runtime" }));
    });
});
