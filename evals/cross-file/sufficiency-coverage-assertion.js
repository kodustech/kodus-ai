/**
 * Sufficiency coverage assertion — measures semantic correctness of the
 * sufficiency evaluation against expected outputs.
 *
 * Metrics:
 *   sufficiency_accuracy — model agrees on sufficient/insufficient (weight: 0.30)
 *   gap_detection        — gaps.length >= expectedMinGaps (weight: 0.20)
 *   query_coverage       — % of expectedQuerySymbols found in additionalQueries (weight: 0.30)
 *   no_duplicates        — none of forbiddenPatterns appear in additionalQueries (weight: 0.20)
 */

function parseOutput(output) {
    try {
        const cleaned = output
            .replace(/^```json\s*/i, '')
            .replace(/```\s*$/, '')
            .trim();
        return JSON.parse(cleaned);
    } catch {
        return null;
    }
}

function stripRegexEscaping(str) {
    return str.replace(/\\([.(){}[\]|*+?^$])/g, '$1');
}

module.exports = (output, context) => {
    const parsed = parseOutput(output);
    if (!parsed) {
        return { pass: false, score: 0, reason: 'Failed to parse output.' };
    }

    const expectedSufficient = JSON.parse(
        context.vars.expectedSufficient || 'null',
    );
    const expectedMinGaps = JSON.parse(
        context.vars.expectedMinGaps || '0',
    );
    const expectedQuerySymbols = JSON.parse(
        context.vars.expectedQuerySymbols || '[]',
    );
    const forbiddenPatterns = JSON.parse(
        context.vars.forbiddenPatterns || '[]',
    );

    const queries = parsed.additionalQueries || [];
    const gaps = parsed.gaps || [];

    // 1. Sufficiency accuracy (30%)
    let sufficiencyScore = 0;
    if (expectedSufficient !== null) {
        sufficiencyScore = parsed.sufficient === expectedSufficient ? 1.0 : 0.0;
    } else {
        sufficiencyScore = 1.0; // No expectation set
    }

    // 2. Gap detection (20%)
    let gapScore = 1.0;
    if (expectedMinGaps > 0) {
        gapScore = gaps.length >= expectedMinGaps ? 1.0 : 0.0;
    }

    // 3. Query coverage (30%) — % of expected symbols found
    let queryCoverageScore = 1.0;
    let matchedSymbols = 0;
    if (expectedQuerySymbols.length > 0) {
        for (const expected of expectedQuerySymbols) {
            const lower = stripRegexEscaping(expected.toLowerCase());
            const found = queries.some((q) => {
                const sym = stripRegexEscaping(
                    (q.symbolName || '').toLowerCase(),
                );
                const pat = stripRegexEscaping(
                    (q.pattern || '').toLowerCase(),
                );
                const rat = (q.rationale || '').toLowerCase();
                return (
                    sym.includes(lower) ||
                    pat.includes(lower) ||
                    rat.includes(lower)
                );
            });
            if (found) matchedSymbols++;
        }
        queryCoverageScore = matchedSymbols / expectedQuerySymbols.length;
    } else if (!expectedSufficient && queries.length === 0) {
        // Expected insufficient but no queries generated — partial penalty
        // (unless expectedQuerySymbols is explicitly empty, which is handled above)
        queryCoverageScore = 1.0;
    }

    // 4. No duplicates (20%) — none of forbiddenPatterns in additionalQueries
    let noDuplicatesScore = 1.0;
    const duplicatesFound = [];
    if (forbiddenPatterns.length > 0 && queries.length > 0) {
        for (const forbidden of forbiddenPatterns) {
            const forbiddenLower = forbidden.toLowerCase();
            for (const q of queries) {
                if (
                    (q.pattern || '').toLowerCase() === forbiddenLower
                ) {
                    duplicatesFound.push(
                        `"${q.pattern}" duplicates forbidden "${forbidden}"`,
                    );
                }
            }
        }
        noDuplicatesScore =
            duplicatesFound.length > 0
                ? Math.max(
                      0,
                      1 - duplicatesFound.length / forbiddenPatterns.length,
                  )
                : 1.0;
    }

    // Weighted final score
    const weights = {
        sufficiency: 0.3,
        gap: 0.2,
        queryCoverage: 0.3,
        noDuplicates: 0.2,
    };

    const finalScore =
        sufficiencyScore * weights.sufficiency +
        gapScore * weights.gap +
        queryCoverageScore * weights.queryCoverage +
        noDuplicatesScore * weights.noDuplicates;

    const fmt = (v) => v.toFixed(3);

    const metrics = `SUFFICIENCY_METRICS accuracy=${fmt(sufficiencyScore)} gap_detection=${fmt(gapScore)} query_coverage=${fmt(queryCoverageScore)} no_duplicates=${fmt(noDuplicatesScore)} final=${fmt(finalScore)}`;

    const details = [
        `Sufficiency: model=${parsed.sufficient}, expected=${expectedSufficient} (${sufficiencyScore === 1 ? 'match' : 'MISMATCH'})`,
        `Gaps: ${gaps.length} found, ${expectedMinGaps} expected minimum`,
        `Query coverage: ${matchedSymbols}/${expectedQuerySymbols.length} expected symbols found`,
        `No duplicates: ${duplicatesFound.length === 0 ? 'clean' : duplicatesFound.join('; ')}`,
        `Queries generated: ${queries.length}`,
    ].join('\n');

    return {
        pass: finalScore >= 0.6,
        score: finalScore,
        reason: `${metrics}\n\n${details}`,
    };
};
