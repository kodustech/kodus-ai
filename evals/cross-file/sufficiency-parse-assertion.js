/**
 * Sufficiency parse assertion — validates JSON structure of sufficiency output.
 *
 * Checks:
 * 1. Output is valid JSON with "sufficient" (boolean), "gaps" (string[]), "additionalQueries" (array)
 * 2. gaps.length <= 5, additionalQueries.length <= 5
 * 3. Each query has required fields (pattern, rationale, riskLevel, symbolName, sourceFile)
 * 4. Each pattern is valid regex
 * 5. Each riskLevel is one of: low, medium, high
 * 6. If sufficient === true, additionalQueries MUST be empty
 */

module.exports = (output, context) => {
    let parsed;
    try {
        const cleaned = output
            .replace(/^```json\s*/i, '')
            .replace(/```\s*$/, '')
            .trim();
        parsed = JSON.parse(cleaned);
    } catch (e) {
        return {
            pass: false,
            score: 0,
            reason: `Failed to parse JSON: ${e.message}`,
        };
    }

    const issues = [];

    // Check top-level fields
    if (typeof parsed.sufficient !== 'boolean') {
        issues.push('"sufficient" must be a boolean');
    }

    if (!Array.isArray(parsed.gaps)) {
        issues.push('"gaps" must be an array');
    } else if (parsed.gaps.length > 5) {
        issues.push(`Too many gaps: ${parsed.gaps.length} (max 5)`);
    }

    if (!Array.isArray(parsed.additionalQueries)) {
        issues.push('"additionalQueries" must be an array');
    } else if (parsed.additionalQueries.length > 5) {
        issues.push(
            `Too many additionalQueries: ${parsed.additionalQueries.length} (max 5)`,
        );
    }

    // If sufficient is true, additionalQueries must be empty
    if (
        parsed.sufficient === true &&
        Array.isArray(parsed.additionalQueries) &&
        parsed.additionalQueries.length > 0
    ) {
        issues.push(
            'sufficient=true but additionalQueries is not empty — contradictory',
        );
    }

    // Validate each query structure + regex
    let validPatterns = 0;
    const queries = parsed.additionalQueries || [];

    for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const missing = [];
        if (!q.pattern) missing.push('pattern');
        if (!q.rationale) missing.push('rationale');
        if (!q.riskLevel) missing.push('riskLevel');
        if (!q.symbolName) missing.push('symbolName');
        if (!q.sourceFile) missing.push('sourceFile');

        if (missing.length > 0) {
            issues.push(
                `Query ${i + 1}: missing fields [${missing.join(', ')}]`,
            );
        }

        if (
            q.riskLevel &&
            !['low', 'medium', 'high'].includes(q.riskLevel)
        ) {
            issues.push(
                `Query ${i + 1}: invalid riskLevel "${q.riskLevel}"`,
            );
        }

        if (q.pattern) {
            try {
                new RegExp(q.pattern);
                validPatterns++;
            } catch {
                issues.push(
                    `Query ${i + 1}: invalid regex "${q.pattern}"`,
                );
            }
        }
    }

    const regexScore =
        queries.length > 0 ? validPatterns / queries.length : 1.0;
    const issuePenalty = Math.min(issues.length * 0.05, 1);
    const score = Math.max(regexScore * (1 - issuePenalty), 0);

    const queryInfo =
        queries.length > 0
            ? `valid_patterns=${validPatterns}/${queries.length}`
            : 'no_queries';

    return {
        pass: score >= 0.9,
        score,
        reason:
            issues.length > 0
                ? `PARSE_METRICS ${queryInfo} issues=${issues.length}\n${issues.join('\n')}`
                : `PARSE_METRICS ${queryInfo} issues=0\nValid structure: sufficient=${parsed.sufficient}, gaps=${parsed.gaps?.length || 0}, queries=${queries.length}.`,
    };
};
