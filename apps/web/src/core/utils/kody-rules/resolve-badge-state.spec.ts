import { KodyRulesStatus } from "@services/kodyRules/types";

import { resolveKodyRuleBadgeState } from "./resolve-badge-state";

describe("resolveKodyRuleBadgeState", () => {
    it("returns null for an active rule", () => {
        expect(
            resolveKodyRuleBadgeState({ status: KodyRulesStatus.ACTIVE }),
        ).toBeNull();
    });

    it("returns 'locked' for a rule paused by the plan limit", () => {
        expect(
            resolveKodyRuleBadgeState({
                status: KodyRulesStatus.PAUSED,
                lockedByPlan: true,
            }),
        ).toBe("locked");
    });

    it("returns 'paused' for a rule the user paused themselves", () => {
        expect(
            resolveKodyRuleBadgeState({
                status: KodyRulesStatus.PAUSED,
                lockedByPlan: false,
            }),
        ).toBe("paused");
    });

    it("returns 'paused' when lockedByPlan is absent (legacy/manual pauses)", () => {
        expect(
            resolveKodyRuleBadgeState({ status: KodyRulesStatus.PAUSED }),
        ).toBe("paused");
    });

    it("returns null for other statuses (pending, rejected, deleted)", () => {
        expect(
            resolveKodyRuleBadgeState({
                status: KodyRulesStatus.PENDING,
                lockedByPlan: true,
            }),
        ).toBeNull();
    });
});
