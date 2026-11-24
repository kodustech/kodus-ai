import {
    CodeReviewSettingsValidationError,
    reviewSettingsSaveErrorMessage,
} from "./settings-save-conflict";

describe("reviewSettingsSaveErrorMessage", () => {
    it("shows the API's own Ultra refusal", () => {
        const reason =
            "Ultra review needs three different models set under Ultra models in Routing, so the review mode was not changed.";
        // Beside other validation text, only the Ultra reason shows.
        expect(
            reviewSettingsSaveErrorMessage(
                new CodeReviewSettingsValidationError([
                    "<raw upstream>",
                    reason,
                ]),
            ),
        ).toBe(reason);
    });

    it("keeps any other validation message bounded", () => {
        expect(
            reviewSettingsSaveErrorMessage(
                new CodeReviewSettingsValidationError(["<raw upstream>"]),
            ),
        ).toBe(
            "Some review settings are invalid. Check your changes before saving again.",
        );
    });
});
