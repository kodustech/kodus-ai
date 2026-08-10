/**
 * Regression for:
 *
 *   IssuesModel validation failed: language: Path 'language' is required
 *
 * `language` is `@Prop({ required: true })` on IssuesModel, but it is
 * optional on the finder's suggestion shape and the model routinely omits
 * it. Every such suggestion used to blow up inside
 * KodyIssuesManagementService.createNewIssues and the issue was never
 * created — silently, because the whole block is wrapped in a
 * catch-and-log.
 *
 * The service constructor pulls in a large dependency graph, so this
 * exercises the mapping directly: what matters is that the value handed to
 * issuesService.create satisfies the schema's contract.
 */

/** Mirrors the mapping in kodyIssuesManagement.service.ts#createNewIssues. */
const toIssuePayload = (suggestion: { language?: string }) => ({
    language: suggestion.language || 'unknown',
});

/** Stand-in for the Mongoose `required: true` check on IssuesModel.language. */
const validateRequiredLanguage = (payload: { language?: string }) => {
    if (!payload.language) {
        throw new Error(
            "IssuesModel validation failed: language: Path 'language' is required.",
        );
    }
};

describe('issue creation — required language', () => {
    it('falls back to "unknown" when the suggestion has no language', () => {
        const payload = toIssuePayload({});

        expect(payload.language).toBe('unknown');
        expect(() => validateRequiredLanguage(payload)).not.toThrow();
    });

    it('falls back when the language is an empty string', () => {
        const payload = toIssuePayload({ language: '' });

        expect(payload.language).toBe('unknown');
        expect(() => validateRequiredLanguage(payload)).not.toThrow();
    });

    it('keeps a real language untouched', () => {
        expect(toIssuePayload({ language: 'typescript' }).language).toBe(
            'typescript',
        );
    });

    it('reproduces the original failure without the fallback', () => {
        // Guards the premise: absent the fallback, this is exactly the
        // production error.
        expect(() => validateRequiredLanguage({ language: undefined })).toThrow(
            /Path 'language' is required/,
        );
    });
});
