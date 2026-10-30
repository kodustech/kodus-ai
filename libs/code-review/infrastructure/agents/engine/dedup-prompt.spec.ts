import {

    contentSimilarity,
    DEDUP_CONTENT_THRESHOLD,
} from './dedup-prompt';

describe('contentSimilarity - one-sided improvedCode (PR #1526 regression)', () => {
    // Two dedup outputs for the SAME bug: identical shared body, but only one
    // side carries an improvedCode block. The code tokens inflate that side's
    // word set and pull Jaccard under the guard threshold, so agent-review.stage
    // keeps a correct duplicate instead of merging it (the live #1526 case).
    it('does not let a one-sided improvedCode dilute a real duplicate below threshold', () => {
        // 8 shared body tokens; each side adds 3 of its own paraphrase tokens.
        const shared = 'alpha bravo charlie delta echo foxtrot golf hotel';
        const withoutCode = {
            oneSentenceSummary: 'alpha bravo charlie',
            suggestionContent: `${shared} papa quebec romeo`, // body set = 11 tokens
        };
        const withCode = {
            oneSentenceSummary: 'alpha bravo charlie',
            suggestionContent: `${shared} sierra tango uniform`, // body set = 11 tokens, inter = 8
            improvedCode:
                'try const result logger convert warn failed rethrow throw wrapped cause parse stack', // +13 tokens
        };

        // Body-only Jaccard = 8/(11+11-8) = 8/14 ≈ 0.57 → clearly the same finding.
        // Current bug: the one-sided code block makes B = 24 tokens, so
        // Jaccard = 8/(11+24-8) = 8/27 ≈ 0.296 < 0.3 → the guard vetoes the merge.
        expect(contentSimilarity(withCode, withoutCode)).toBeGreaterThanOrEqual(
            DEDUP_CONTENT_THRESHOLD,
        );
    });
});
