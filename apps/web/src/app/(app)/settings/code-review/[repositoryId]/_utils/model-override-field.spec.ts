import { FormattedConfigLevel, type CodeReviewFormType } from "../../_types";
import { withModelOverrideField } from "./model-override-field";

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
