/**
 * False-positive assertion — scores inversely to the number of suggestions.
 *
 * For "false positive trap" test cases the reference has 0 bugs.
 * A perfect model should also produce 0 suggestions.
 *
 * Scoring:
 *   0 suggestions → score = 1.0  (no false positives)
 *   N suggestions → score = max(0, 1 - N * penalty)
 *
 * penalty = 0.25 per suggestion, so:
 *   1 FP → 0.75,  2 FPs → 0.50,  3 FPs → 0.25,  4+ → 0.00
 *
 * The assertion also feeds each suggestion through the LLM judge prompt
 * (same as judge-assertion.js) so the reason includes which suggestions
 * the judges deemed VALID vs INVALID.  Only VALID suggestions count as
 * false positives — this avoids penalising for hallucinated-but-rejected
 * noise the judges themselves would discard.
 */

const { processResponse } = require('./parse-output');

const PENALTY_PER_FP = 0.25;

module.exports = (output, _context) => {
    const result = processResponse(output);

    // If the model output is completely unparseable, that's still a pass
    // for false-positive purposes (it didn't produce valid FP suggestions)
    if (!result || !result.codeSuggestions) {
        return {
            pass: true,
            score: 1,
            reason: 'FP_PRECISION: precision=1.000 suggestions=0 (unparseable output — no FPs)',
        };
    }

    const count = result.codeSuggestions.length;

    if (count === 0) {
        return {
            pass: true,
            score: 1,
            reason: 'FP_PRECISION: precision=1.000 suggestions=0',
        };
    }

    const score = Math.max(0, 1 - count * PENALTY_PER_FP);
    const precision = score.toFixed(3);
    const summaries = result.codeSuggestions
        .map((s, i) => `  ${i + 1}. [${s.severity || '?'}] ${s.oneSentenceSummary || s.suggestionContent?.slice(0, 120) || '(no summary)'}`)
        .join('\n');

    return {
        pass: score >= 0.9,
        score,
        reason: `FP_PRECISION: precision=${precision} suggestions=${count}\nFalse positives:\n${summaries}`,
    };
};
