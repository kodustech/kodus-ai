import { FormattedConfigLevel, type CodeReviewFormType } from "../../_types";
import {
    withModelOverrideField,
    withoutUntouchedModelOverride,
} from "./model-override-field";

const level = FormattedConfigLevel;

describe("withModelOverrideField", () => {
    it("seeds an inheriting override when the config has none", () => {
        expect(
            withModelOverrideField({
                byokModel: { value: "", level: level.DEFAULT },
            } as Partial<CodeReviewFormType>).byokModelId,
        ).toEqual({ value: "", level: level.DEFAULT });
    });

    it("carries a legacy model name over, as the selector shows it", () => {
        expect(
            withModelOverrideField({
                byokModel: { value: "gpt-5", level: level.REPOSITORY },
            } as Partial<CodeReviewFormType>).byokModelId,
        ).toEqual({ value: "gpt-5", level: level.REPOSITORY });
    });

    it("leaves an id-based override alone", () => {
        const values = {
            byokModelId: { value: "m-1", level: level.GLOBAL },
            byokModel: { value: "gpt-5", level: level.DEFAULT },
        } as Partial<CodeReviewFormType>;

        expect(withModelOverrideField(values)).toBe(values);
    });

    it("works on a config with no model fields at all", () => {
        expect(
            withModelOverrideField({} as Partial<CodeReviewFormType>)
                .byokModelId,
        ).toEqual({
            value: "",
            level: level.DEFAULT,
        });
    });
});

describe("withoutUntouchedModelOverride", () => {
    const payload = { byokModelId: "gpt-5", runOnDraft: true };

    it("leaves the seeded model out when the user did not touch it", () => {
        expect(
            withoutUntouchedModelOverride(payload, "gpt-5", "gpt-5"),
        ).toEqual({ runOnDraft: true });
    });

    it("treats a missing value like inherit", () => {
        expect(
            withoutUntouchedModelOverride(
                { byokModelId: "", runOnDraft: true },
                undefined,
                "",
            ),
        ).toEqual({ runOnDraft: true });
    });

    it("sends a model the user picked", () => {
        expect(withoutUntouchedModelOverride(payload, "m-2", "gpt-5")).toBe(
            payload,
        );
    });

    it("sends a cleared override, so the scope inherits again", () => {
        const cleared = { byokModelId: "", runOnDraft: true };

        expect(withoutUntouchedModelOverride(cleared, "", "m-1")).toBe(cleared);
    });
});
