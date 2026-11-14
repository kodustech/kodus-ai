import { setImmediate as nextTurn } from 'node:timers/promises';
import { estimateTextTokens } from '@libs/llm/token-estimate';

// Bound each synchronous encode, not the input accepted by the assessment.
export const ENCODING_CHARS_PER_TURN = 64_000;

export async function estimateRiskPromptTokens(
    prompt: string,
): Promise<number> {
    if (prompt.length <= ENCODING_CHARS_PER_TURN) {
        return estimateTextTokens(prompt);
    }
    let tokens = 0;
    let start = 0;
    while (start < prompt.length) {
        let end = Math.min(start + ENCODING_CHARS_PER_TURN, prompt.length);
        // Preserve Unicode code points at encoding boundaries.
        if (
            end < prompt.length &&
            /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(
                prompt.slice(end - 1, end + 1),
            )
        ) {
            end--;
        }
        // Cached slices could keep their entire parent prompt resident.
        tokens += estimateTextTokens(prompt.slice(start, end), {
            cache: false,
        });
        start = end;
        if (start < prompt.length) await nextTurn();
    }
    return tokens;
}
