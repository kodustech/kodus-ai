import {
    findFirstDirtyFieldOutsidePromptOverrides,
    hasDirtyFieldsOutsidePromptOverrides,
    shouldBlockCodeReviewLayoutNavigation,
} from "./layout-dirty-state";

describe("layout-dirty-state", () => {
    it("does not treat prompt-only dirty fields as shared dirty fields", () => {
        const dirtyFields = {
            v2PromptOverrides: {
                generation: {
                    main: {
                        value: true,
                    },
                },
            },
        };

        expect(
            hasDirtyFieldsOutsidePromptOverrides(dirtyFields, [
                "v2PromptOverrides",
            ]),
        ).toBe(false);
        expect(
            findFirstDirtyFieldOutsidePromptOverrides(dirtyFields, "", [
                "v2PromptOverrides",
            ]),
        ).toBeNull();
        expect(
            shouldBlockCodeReviewLayoutNavigation({
                dirtyFields,
                formIsSubmitting: false,
            }),
        ).toBe(false);
    });

    it("blocks navigation when a shared settings field is dirty", () => {
        const dirtyFields = {
            reviewOptions: {
                security: true,
            },
        };

        expect(
            shouldBlockCodeReviewLayoutNavigation({
                dirtyFields,
                formIsSubmitting: false,
            }),
        ).toBe(true);
    });

    it("blocks navigation while the form is submitting", () => {
        expect(
            shouldBlockCodeReviewLayoutNavigation({
                dirtyFields: {},
                formIsSubmitting: true,
            }),
        ).toBe(true);
    });
});
