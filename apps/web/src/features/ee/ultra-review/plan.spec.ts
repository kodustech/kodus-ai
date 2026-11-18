import {
    mergeRoutingEdits,
    normalizeRouting,
    sameRouting,
} from "src/features/ee/byok/_components/routing/routing-state";

import { isUltraReviewPlan, isUltraTrioSet, ultraTrioError } from "./plan";

describe("isUltraReviewPlan", () => {
    it("allows the plans that run heavy, a trial included, and refuses free", () => {
        const license = (subscriptionStatus: string, planType?: string) =>
            ({ valid: true, subscriptionStatus, planType }) as any;
        expect(isUltraReviewPlan(license("active", "teams_byok"))).toBe(true);
        expect(isUltraReviewPlan(license("trial", "teams_managed"))).toBe(
            true,
        );
        expect(isUltraReviewPlan(license("active", "free_byok"))).toBe(false);
        expect(isUltraReviewPlan(null)).toBe(false);
    });
});

describe("the Ultra trio", () => {
    it("is set only with three different models", () => {
        expect(isUltraTrioSet(["a", "b", "c"])).toBe(true);
        expect(isUltraTrioSet(["a", "b", ""])).toBe(false);
        expect(isUltraTrioSet(["a", "a", "b"])).toBe(false);
        expect(isUltraTrioSet(undefined)).toBe(false);
    });

    it("blocks a save only while partly picked or repeated", () => {
        expect(ultraTrioError(undefined)).toBeUndefined();
        expect(ultraTrioError(["", "", ""])).toBeUndefined();
        expect(ultraTrioError(["a", "b", "c"])).toBeUndefined();
        expect(ultraTrioError(["a", "", ""])).toBe(
            "Select three different models to save Ultra.",
        );
        expect(ultraTrioError(["a", "a", "b"])).toBeDefined();
    });

    it("survives the routing normalization every routing save goes through", () => {
        const routing = normalizeRouting({
            defaultModelId: "a",
            ultraModelIds: ["c", "a", "b"],
        });
        expect(routing.ultraModelIds).toEqual(["c", "a", "b"]);
        expect(normalizeRouting({ ultraModelIds: ["", "", ""] }).ultraModelIds)
            .toBeUndefined();
        expect(
            sameRouting(
                { ultraModelIds: ["a", "b", "c"] },
                { ultraModelIds: ["a", "c", "b"] },
            ),
        ).toBe(false);
    });

    it("merges only an edited trio over another editor's routing", () => {
        const baseline = { defaultModelId: "a" };
        const current = { defaultModelId: "a", ultraModelIds: ["x", "y", "z"] };
        // Not edited here: the other editor's trio stays.
        expect(
            mergeRoutingEdits(baseline, { defaultModelId: "b" }, current)
                .ultraModelIds,
        ).toEqual(["x", "y", "z"]);
        // Edited here: this trio wins.
        expect(
            mergeRoutingEdits(
                baseline,
                { defaultModelId: "a", ultraModelIds: ["c", "a", "b"] },
                current,
            ).ultraModelIds,
        ).toEqual(["c", "a", "b"]);
    });
});
