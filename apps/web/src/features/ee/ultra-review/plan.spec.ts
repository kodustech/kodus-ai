import {
    mergeRoutingEdits,
    normalizeRouting,
    sameRouting,
} from "src/features/ee/byok/_components/routing/routing-state";

import {
    isUltraReviewPlan,
    isUltraTrioSet,
    normalizeUltraModel,
    ultraModelUsable,
    ultraTrioError,
} from "./plan";

describe("isUltraReviewPlan", () => {
    it("allows the plans that run heavy, a trial included, and refuses free", () => {
        const license = (subscriptionStatus: string, planType?: string) =>
            ({ valid: true, subscriptionStatus, planType }) as any;
        expect(isUltraReviewPlan(license("active", "teams_byok"))).toBe(true);
        expect(isUltraReviewPlan(license("trial", "teams_managed"))).toBe(true);
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

    it("while a review mode here is Ultra, clearing the trio is blocked too", () => {
        const required =
            "Ultra is a review mode here. Keep three models, or change the mode first.";
        expect(ultraTrioError(undefined, true)).toBe(required);
        expect(ultraTrioError(["", "", ""], true)).toBe(required);
        expect(ultraTrioError(["a", "b", "c"], true)).toBeUndefined();
        expect(ultraTrioError(["a", "", ""], true)).toBe(
            "Select three different models to save Ultra.",
        );
    });

    it("survives the routing normalization every routing save goes through", () => {
        const routing = normalizeRouting({
            defaultModelId: "a",
            ultraModelIds: ["c", "a", "b"],
        });
        expect(routing.ultraModelIds).toEqual(["c", "a", "b"]);
        expect(
            normalizeRouting({ ultraModelIds: ["", "", ""] }).ultraModelIds,
        ).toBeUndefined();
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

describe("normalizeUltraModel", () => {
    it.each([
        ["us.anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5"],
        ["claude-opus-5-5-20261101", "claude-opus-5-5"],
        ["gpt-6.1-sol-2026-05-01", "gpt-6-1-sol"],
        ["deepseek-v4", "deepseek-v4"],
        ["kimi-k2-0905", "kimi-k2-0905"],
    ])("reads %s as %s, as the API does", (raw, normalized) => {
        expect(normalizeUltraModel(raw)).toBe(normalized);
    });
});

describe("a trio model that can no longer run", () => {
    const models = [
        { modelId: "a", model: "m-a", resolvable: true },
        { modelId: "b", model: "m-b", resolvable: false },
        { modelId: "c", model: "m-c", resolvable: true },
        { modelId: "k", model: "m-k", resolvable: true, managed: true },
    ];
    const usable = ultraModelUsable(models);

    it("leaves the trio unset, as the server's save check does", () => {
        expect(isUltraTrioSet(["a", "b", "c"], undefined, usable)).toBe(false);
        expect(isUltraTrioSet(["a", "k", "c"], undefined, usable)).toBe(false);
        expect(isUltraTrioSet(["a", "b", "c"])).toBe(true);
    });

    it("blocks the save, naming why", () => {
        expect(ultraTrioError(["a", "b", "c"], false, undefined, usable)).toBe(
            "A model picked for Ultra can no longer run. Reconnect its provider or pick another.",
        );
    });
});
