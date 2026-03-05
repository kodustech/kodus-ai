/**
 * Planner coverage assertion — measures symbol coverage, upstream coverage,
 * false positive rate, and category coverage.
 *
 * Returns a combined score with detailed breakdown in reason.
 *
 * Metrics:
 *   symbol_coverage   — % of expectedSymbols found in queries (weight: 0.30)
 *   upstream_coverage  — % of expectedUpstreamSymbols found (weight: 0.25)
 *   fp_rate           — 1 - (false positives / total queries) (weight: 0.25)
 *   category_coverage  — category diversity heuristic (weight: 0.20)
 */

function parseQueries(output) {
    try {
        const cleaned = output
            .replace(/^```json\s*/i, '')
            .replace(/```\s*$/, '')
            .trim();
        const parsed = JSON.parse(cleaned);
        return parsed.queries || [];
    } catch {
        return [];
    }
}

function stripRegexEscaping(str) {
    return str.replace(/\\([.(){}[\]|*+?^$])/g, '$1');
}

function matchesSymbol(queries, symbol) {
    const lower = stripRegexEscaping(symbol.toLowerCase());
    return queries.some((q) => {
        const sym = stripRegexEscaping((q.symbolName || '').toLowerCase());
        const pat = stripRegexEscaping((q.pattern || '').toLowerCase());
        return sym === lower || sym.includes(lower) || pat.includes(lower);
    });
}

function computeSymbolCoverage(queries, expectedSymbols) {
    if (expectedSymbols.length === 0) return { score: 1.0, matched: 0, total: 0 };
    let matched = 0;
    for (const sym of expectedSymbols) {
        if (matchesSymbol(queries, sym)) matched++;
    }
    return { score: matched / expectedSymbols.length, matched, total: expectedSymbols.length };
}

function computeFalsePositiveRate(queries, allExpected) {
    if (queries.length === 0) return { score: 1.0, fp: 0, total: 0 };
    const expectedLower = new Set(allExpected.map((s) => stripRegexEscaping(s.toLowerCase())));
    let fp = 0;
    for (const q of queries) {
        const sym = stripRegexEscaping((q.symbolName || '').toLowerCase());
        const patternMatchesAny = allExpected.some((s) =>
            stripRegexEscaping((q.pattern || '').toLowerCase()).includes(stripRegexEscaping(s.toLowerCase())),
        );
        if (!sym || (!expectedLower.has(sym) && !patternMatchesAny)) {
            fp++;
        }
    }
    return { score: 1 - fp / queries.length, fp, total: queries.length };
}

function computeCategoryCoverage(queries) {
    if (queries.length === 0) return { score: 0, found: [] };

    const allText = queries
        .map((q) => `${(q.rationale || '').toLowerCase()} ${(q.symbolName || '').toLowerCase()} ${(q.pattern || '').toLowerCase()}`)
        .join(' ');

    const categories = [
        ['consumer', ['consumer', 'caller', 'call site', 'usage', 'invocation']],
        ['symmetric', ['symmetric', 'counterpart', 'sibling', 'mirror', 'verify', 'validate']],
        ['test', ['test', 'spec', 'assert', 'expect', 'mock', 'describe']],
        ['config', ['config', 'limit', 'threshold', 'constant', 'env', 'setting']],
        ['upstream', ['upstream', 'dependency', 'depend', 'import', 'provider', 'inject', 'implementation']],
    ];

    const found = [];
    for (const [name, keywords] of categories) {
        if (keywords.some((kw) => allText.includes(kw))) {
            found.push(name);
        }
    }

    return { score: Math.min(found.length / 4, 1.0), found };
}

module.exports = (output, context) => {
    const queries = parseQueries(output);
    if (queries.length === 0) {
        return { pass: false, score: 0, reason: 'No queries to evaluate.' };
    }

    const expectedSymbols = JSON.parse(context.vars.expectedSymbols || '[]');
    const expectedUpstream = JSON.parse(context.vars.expectedUpstreamSymbols || '[]');
    const allExpected = [...expectedSymbols, ...expectedUpstream];

    // Compute all metrics
    const symCov = computeSymbolCoverage(queries, expectedSymbols);
    const upCov = computeSymbolCoverage(queries, expectedUpstream);
    const fpRate = computeFalsePositiveRate(queries, allExpected);
    const catCov = computeCategoryCoverage(queries);

    // Weighted final score
    const weights = { symbol: 0.30, upstream: 0.25, fp: 0.25, category: 0.20 };
    const finalScore =
        symCov.score * weights.symbol +
        upCov.score * weights.upstream +
        fpRate.score * weights.fp +
        catCov.score * weights.category;

    const fmt = (v) => v.toFixed(3);

    const metrics = `COVERAGE_METRICS symbol_coverage=${fmt(symCov.score)} upstream_coverage=${fmt(upCov.score)} fp_rate=${fmt(fpRate.score)} category_coverage=${fmt(catCov.score)} final=${fmt(finalScore)}`;

    const details = [
        `Symbol coverage: ${symCov.matched}/${symCov.total} (${(symCov.score * 100).toFixed(1)}%)`,
        `Upstream coverage: ${upCov.matched}/${upCov.total} (${(upCov.score * 100).toFixed(1)}%)`,
        `False positive rate: ${fpRate.fp}/${fpRate.total} FP (score=${(fpRate.score * 100).toFixed(1)}%)`,
        `Category coverage: ${catCov.found.join(', ')} (${(catCov.score * 100).toFixed(1)}%)`,
        `Queries generated: ${queries.length}`,
    ].join('\n');

    return {
        pass: finalScore >= 0.5,
        score: finalScore,
        reason: `${metrics}\n\n${details}`,
    };
};
