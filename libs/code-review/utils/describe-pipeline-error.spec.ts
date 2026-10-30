import {
    LlmErrorCategory,
    attachClassification,
} from '@libs/llm/error-classifier';

import { describePipelineError } from './describe-pipeline-error';

describe('describePipelineError', () => {
    const wrap = (error: Error) => ({ stage: 'AnyStage', error });

    it('prefers the classification attached at the throw site', () => {
        const error = new Error('Not Found');
        attachClassification(error, {
            category: LlmErrorCategory.MODEL_NOT_FOUND,
            rawMessage: 'Not Found',
            friendlyMessage: 'The configured model is not available.',
        });

        expect(describePipelineError(wrap(error))).toEqual({
            text: 'The configured model is not available.',
            classified: true,
        });
    });

    // Only the code that made the LLM call knows the error IS an LLM error.
    // Re-classifying here turned "GitHub API rate limit exceeded" into "Rate
    // limit reached on the provider" — pointing the user at the wrong system.
    it('does NOT re-classify an unattached error, even one that looks LLM-ish', () => {
        const githubError = Object.assign(
            new Error('GitHub API rate limit exceeded'),
            { statusCode: 403 },
        );

        expect(describePipelineError(wrap(githubError))).toEqual({
            text: 'GitHub API rate limit exceeded',
            classified: false,
        });
    });

    it('falls back to the raw message when nothing classifies', () => {
        expect(describePipelineError(wrap(new Error('disk on fire')))).toEqual({
            text: 'disk on fire',
            classified: false,
        });
    });

    it('cuts a multi-sentence internal message down to its first sentence', () => {
        const rationale =
            'Kody Rules could not be evaluated: all 3 rule checks failed to run. ' +
            'Reporting 0 findings would green-wash a review that evaluated nothing, ' +
            'so we fail loudly instead and mark the execution degraded for the operator.';

        const { text } = describePipelineError(wrap(new Error(rationale)));

        expect(text).toBe(
            'Kody Rules could not be evaluated: all 3 rule checks failed to run.',
        );
    });

    it('collapses newlines so the UI never renders a run-on block', () => {
        const { text } = describePipelineError(
            wrap(new Error('first line\n\n  second line')),
        );

        expect(text).toBe('first line second line');
    });

    it('returns empty for a missing error rather than throwing', () => {
        expect(describePipelineError(undefined)).toEqual({
            text: '',
            classified: false,
        });
    });
});
