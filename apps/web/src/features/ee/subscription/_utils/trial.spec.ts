import { describe, expect, it } from "@jest/globals";

import {
    getTrialCardState,
    getTrialCreditBalance,
    getTrialTierLabel,
    getTrialUnlocks,
} from "./trial";

describe("getTrialCardState", () => {
    it("byok wins regardless of credit data", () => {
        expect(getTrialCardState({ byok: true, hasCredits: true })).toBe(
            "byok",
        );
        expect(getTrialCardState({ byok: true, hasCredits: false })).toBe(
            "byok",
        );
    });

    it("credits when no byok and live credit data", () => {
        expect(getTrialCardState({ byok: false, hasCredits: true })).toBe(
            "credits",
        );
    });

    it("legacy when no byok and no credit data", () => {
        expect(getTrialCardState({ byok: false, hasCredits: false })).toBe(
            "legacy",
        );
        expect(getTrialCardState({ hasCredits: false })).toBe("legacy");
    });
});

describe("trial subscription helpers", () => {
    it("reports no allowance of its own when billing has not returned live credits", () => {
        expect(getTrialCreditBalance()).toEqual({
            total: 0,
            used: 0,
            remaining: 0,
            hasLiveData: false,
            percentUsed: 0,
        });
    });

    it("does not invent a balance from a used count alone", () => {
        expect(getTrialCreditBalance({ used: 3 })).toMatchObject({
            hasLiveData: false,
            total: 0,
            remaining: 0,
            percentUsed: 0,
        });
    });

    it("derives the total from used + remaining when billing omits it", () => {
        expect(getTrialCreditBalance({ used: 2, remaining: 5 })).toMatchObject({
            total: 7,
            used: 2,
            remaining: 5,
            hasLiveData: true,
        });
    });

    it("uses live billing credit data when available", () => {
        expect(
            getTrialCreditBalance({
                total: 8,
                used: 6,
                remaining: 2,
            }),
        ).toMatchObject({
            total: 8,
            used: 6,
            remaining: 2,
            hasLiveData: true,
            percentUsed: 75,
        });
    });

    it("maps internal trial tiers to customer-facing labels", () => {
        expect(getTrialTierLabel("base")).toBe("Base");
        expect(getTrialTierLabel("team_signal")).toBe("Team signal");
        expect(getTrialTierLabel("qualified")).toBe("Qualified");
        expect(getTrialTierLabel("unknown")).toBe("Base");
    });

    it("marks BYOK unlock as completed when BYOK is active", () => {
        const byokUnlock = getTrialUnlocks({ byok: true }).find(
            (unlock) => unlock.key === "byok",
        );

        expect(byokUnlock).toMatchObject({
            status: "completed",
            rewardLabel: "Unlimited with your key",
        });
    });

    it("overrides fallback unlock status with billing unlock data", () => {
        const unlocks = getTrialUnlocks({
            billingUnlocks: [
                {
                    key: "code_org_10_plus",
                    status: "completed",
                    rewardCredits: 20,
                },
            ],
        });

        expect(
            unlocks.find((unlock) => unlock.key === "code_org_10_plus"),
        ).toMatchObject({
            status: "completed",
            rewardLabel: "+20 reviews",
        });
    });

    it("keeps billing-only unlocks so new trial experiments can render without frontend changes", () => {
        const unlocks = getTrialUnlocks({
            billingUnlocks: [
                {
                    key: "manual_extension",
                    title: "Sales extension",
                    description: "Manual extension approved by sales.",
                    status: "claimed",
                },
            ],
        });

        expect(
            unlocks.find((unlock) => unlock.key === "manual_extension"),
        ).toMatchObject({
            title: "Sales extension",
            status: "claimed",
            rewardLabel: "Manual review",
        });
    });
});
