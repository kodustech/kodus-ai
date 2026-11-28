import { getOrganizationReleaseTrack } from "@services/organizations/release-track";

import { isKodyRuntimeReleased } from "./kody-runtime";
import { isFeatureEnabled } from "./resolver";

jest.mock("./resolver", () => ({ isFeatureEnabled: jest.fn() }));
jest.mock("@services/organizations/release-track", () => ({
    getOrganizationReleaseTrack: jest.fn(),
}));

describe("whether the web shows Kody Runtime to the org", () => {
    beforeEach(() => jest.clearAllMocks());
    afterEach(() => expect(isFeatureEnabled).not.toHaveBeenCalled());

    it("shows it to an org on the alpha track", async () => {
        (getOrganizationReleaseTrack as jest.Mock).mockResolvedValue("alpha");
        await expect(isKodyRuntimeReleased()).resolves.toBe(true);
    });

    it("hides it from an org on the beta or stable track", async () => {
        (getOrganizationReleaseTrack as jest.Mock).mockResolvedValue("beta");
        await expect(isKodyRuntimeReleased()).resolves.toBe(false);
        (getOrganizationReleaseTrack as jest.Mock).mockResolvedValue("stable");
        await expect(isKodyRuntimeReleased()).resolves.toBe(false);
    });

    it("takes the track the layout already fetched, and hides it when that fetch fails", async () => {
        await expect(
            isKodyRuntimeReleased(Promise.resolve("alpha")),
        ).resolves.toBe(true);
        await expect(
            isKodyRuntimeReleased(Promise.reject(new Error("down"))),
        ).resolves.toBe(false);
        expect(getOrganizationReleaseTrack).not.toHaveBeenCalled();
    });
});
