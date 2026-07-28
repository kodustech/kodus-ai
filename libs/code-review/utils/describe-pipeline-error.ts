/**
 * Turns a PipelineError into one sentence a user can act on.
 *
 * Every surface that reports a failed review — the per-stage rows in the PR
 * logs UI, the "Kody Review Finished" summary, the check-run text — used to
 * print `error.message` verbatim. For LLM failures that is a bare status
 * phrase ("Not Found"); for internal guards it is a paragraph of developer
 * rationale. Neither tells the user what to do, and concatenating several of
 * them produced unreadable run-ons (#1568).
 *
 * Only a classification ATTACHED AT THE THROW SITE is used. Re-classifying an
 * arbitrary pipeline error here would misattribute it: `classifyLLMError` reads
 * generic signals (a 403, the words "rate limit"), so a GitHub API failure came
 * out as "Rate limit reached on the provider. Try again in a few minutes." —
 * confidently pointing the user at the wrong system. The code that made the LLM
 * call is the only place that knows the error IS an LLM error; when it says so
 * we use its wording, otherwise we pass the real message through.
 */
import { LlmErrorCategory, getClassification } from '@libs/llm/error-classifier';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';

export interface DescribedPipelineError {
    text: string;
    /** True when a category was identified, so the text is actionable advice
     *  rather than a passed-through provider/internal string. Callers use this
     *  to pick the most useful reason out of several. */
    classified: boolean;
}

/** Longest raw message we inline before truncating. */
const MAX_RAW_LENGTH = 160;

export function describePipelineError(
    error: PipelineError | undefined,
): DescribedPipelineError {
    const raw = error?.error;
    if (!raw) {
        return { text: '', classified: false };
    }

    const classification = getClassification(raw);
    if (
        classification &&
        classification.category !== LlmErrorCategory.UNKNOWN
    ) {
        return { text: classification.friendlyMessage, classified: true };
    }

    return { text: toOneLine(raw.message || String(raw)), classified: false };
}

/**
 * Collapse to a single line and cap the length. Internal guards throw
 * multi-sentence explanations aimed at whoever reads the code; the UI gets the
 * first sentence, which is the part that names what broke.
 */
function toOneLine(message: string): string {
    const flattened = message.replace(/\s+/g, ' ').trim();
    if (flattened.length <= MAX_RAW_LENGTH) {
        return flattened;
    }

    // Prefer cutting at a sentence boundary so the result reads as a whole
    // thought rather than a string that stops mid-word.
    const firstSentence = flattened.slice(0, MAX_RAW_LENGTH).match(/^.*?[.!?](?=\s)/);
    if (firstSentence?.[0] && firstSentence[0].length > 40) {
        return firstSentence[0];
    }

    return `${flattened.slice(0, MAX_RAW_LENGTH).trimEnd()}…`;
}
