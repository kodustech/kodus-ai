/**
 * Assertion for the enrichRationales() eval.
 *
 * Checks:
 * 1. Output is valid JSON array of {index, rationale} objects
 * 2. Coverage: one entry per snippet
 * 3. Quality: rationales are content-aware (different from generic originals,
 *    substantive, mention specific code elements)
 *
 * Scoring: 40% coverage + 60% quality. Pass threshold: 0.7
 */
module.exports = function (output, context) {
    const vars = context.vars || {};
    const snippetCount = parseInt(vars.snippetCount, 10);
    const originalRationales = JSON.parse(vars.originalRationales || '[]');

    // 1. Parse JSON output
    let parsed;
    try {
        let clean = typeof output === 'string' ? output : JSON.stringify(output);
        // Strip markdown code fences if present
        clean = clean.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
        parsed = typeof clean === 'string' ? JSON.parse(clean) : clean;
    } catch (e) {
        return {
            pass: false,
            score: 0,
            reason: `Failed to parse output as JSON: ${e.message}`,
        };
    }

    // 2. Check it's an array
    if (!Array.isArray(parsed)) {
        return {
            pass: false,
            score: 0,
            reason: `Output is not an array, got ${typeof parsed}`,
        };
    }

    // 3. Coverage — should have entries for all snippets
    const indices = parsed.map(item => item.index);
    let coverageScore = 0;
    for (let i = 0; i < snippetCount; i++) {
        if (indices.includes(i)) coverageScore++;
    }
    const coverageRatio = snippetCount > 0 ? coverageScore / snippetCount : 0;

    // 4. Quality — enriched rationales should be content-aware
    let qualityScore = 0;
    const qualityDetails = [];

    for (const item of parsed) {
        if (typeof item.index !== 'number' || typeof item.rationale !== 'string') continue;

        const enriched = item.rationale;
        const original = originalRationales[item.index] || '';

        // a) Different from original (not just a copy)
        const isDifferent = enriched.toLowerCase().trim() !== original.toLowerCase().trim();

        // b) Substantive (> 30 chars, not trivially short)
        const isSubstantive = enriched.length > 30;

        // c) Mentions specific code elements from the snippet
        //    (function names, class names, patterns, mechanisms)
        const codePatterns = /\b(function|class|method|return|import|export|async|await|query|pool|validate|hash|mock|jest|pipe|controller|decorator|service|param|type|interface|const|module|array|string|number|call|delegate|enforce|constraint|guard|check|sanitiz|normalize|format|map|filter|create|execute|resolve|reject|throw|error|handle|wrap|inject)\b/i;
        const mentionsCode = codePatterns.test(enriched);

        // d) Describes a mechanism or contract (uses explanatory language)
        const mechanismPatterns = /\b(because|since|therefore|ensures|guarantees|delegates|proves|shows|handles|prevents|validates|enforces|wraps|already|happens|executes|receives|returns|passes|calls|uses)\b/i;
        const describesMechanism = mechanismPatterns.test(enriched);

        const itemScore =
            (isDifferent ? 0.25 : 0) +
            (isSubstantive ? 0.25 : 0) +
            (mentionsCode ? 0.25 : 0) +
            (describesMechanism ? 0.25 : 0);

        qualityScore += itemScore;

        qualityDetails.push({
            index: item.index,
            enriched: enriched.substring(0, 120) + (enriched.length > 120 ? '...' : ''),
            original: original.substring(0, 80),
            isDifferent,
            isSubstantive,
            mentionsCode,
            describesMechanism,
            score: itemScore.toFixed(2),
        });
    }

    const avgQuality = parsed.length > 0 ? qualityScore / parsed.length : 0;

    // Combined score: 40% coverage + 60% quality
    const finalScore = 0.4 * coverageRatio + 0.6 * avgQuality;

    return {
        pass: finalScore >= 0.7,
        score: finalScore,
        reason: `Coverage: ${coverageScore}/${snippetCount} (${(coverageRatio * 100).toFixed(0)}%), Quality: ${(avgQuality * 100).toFixed(0)}%\n${qualityDetails.map(d => `  [${d.index}] score=${d.score} | diff=${d.isDifferent} subst=${d.isSubstantive} code=${d.mentionsCode} mech=${d.describesMechanism}\n    Original: "${d.original}"\n    Enriched: "${d.enriched}"`).join('\n')}`,
    };
};
