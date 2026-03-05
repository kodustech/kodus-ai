/**
 * Planner parse assertion — validates JSON structure and regex pattern validity.
 *
 * Checks:
 * 1. Output is valid JSON with a "queries" array
 * 2. Each query has required fields (pattern, rationale, riskLevel, sourceFile)
 * 3. Each pattern is valid regex
 * 4. Max 10 queries
 */

module.exports = (output, context) => {
    let parsed;
    try {
        // Handle both raw JSON and markdown-wrapped JSON
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

    const queries = parsed.queries;
    if (!Array.isArray(queries)) {
        return {
            pass: false,
            score: 0,
            reason: 'Missing or invalid "queries" array in output.',
        };
    }

    if (queries.length === 0) {
        return {
            pass: false,
            score: 0,
            reason: 'Empty queries array — planner generated no search queries.',
        };
    }

    if (queries.length > 10) {
        return {
            pass: false,
            score: 0.5,
            reason: `Too many queries: ${queries.length} (max 10).`,
        };
    }

    // Validate each query structure + regex
    const issues = [];
    let validPatterns = 0;

    for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const missing = [];
        if (!q.pattern) missing.push('pattern');
        if (!q.rationale) missing.push('rationale');
        if (!q.riskLevel) missing.push('riskLevel');
        if (!q.sourceFile) missing.push('sourceFile');

        if (missing.length > 0) {
            issues.push(`Query ${i + 1}: missing fields [${missing.join(', ')}]`);
        }

        if (q.riskLevel && !['low', 'medium', 'high'].includes(q.riskLevel)) {
            issues.push(`Query ${i + 1}: invalid riskLevel "${q.riskLevel}"`);
        }

        if (q.pattern) {
            try {
                new RegExp(q.pattern);
                validPatterns++;
            } catch {
                issues.push(`Query ${i + 1}: invalid regex "${q.pattern}"`);
            }
        }
    }

    const regexScore = queries.length > 0 ? validPatterns / queries.length : 0;
    const issuePenalty = Math.min(issues.length * 0.05, 1);
    const score = Math.max(regexScore * (1 - issuePenalty), 0);

    return {
        pass: score >= 0.9,
        score,
        reason: issues.length > 0
            ? `PARSE_METRICS valid_patterns=${validPatterns}/${queries.length} issues=${issues.length}\n${issues.join('\n')}`
            : `PARSE_METRICS valid_patterns=${validPatterns}/${queries.length} issues=0\nAll ${queries.length} queries have valid structure and regex patterns.`,
    };
};
