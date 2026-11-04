import { isHeavyModePlan } from "./plan";

describe("isHeavyModePlan", () => {
    it.each([
        [
            {
                valid: true,
                subscriptionStatus: "active",
                planType: "teams_byok",
            },
            true,
        ],
        [
            {
                valid: true,
                subscriptionStatus: "active",
                planType: "enterprise_managed_annual",
            },
            true,
        ],
        [{ valid: true, subscriptionStatus: "trial" }, true],
        [
            {
                valid: true,
                subscriptionStatus: "licensed-self-hosted",
                planType: "enterprise",
            },
            true,
        ],
        [
            {
                valid: true,
                subscriptionStatus: "licensed-self-hosted",
                planType: "teams",
            },
            true,
        ],
        [
            {
                valid: true,
                subscriptionStatus: "active",
                planType: "free_byok",
            },
            false,
        ],
        [{ valid: true, subscriptionStatus: "self-hosted" }, false],
        [{ valid: false, subscriptionStatus: "canceled" }, false],
        [null, false],
    ])("%j → %s", (license, expected) => {
        expect(isHeavyModePlan(license as any)).toBe(expected);
    });
});
