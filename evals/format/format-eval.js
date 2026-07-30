// Format-eval automated metrics (no LLM judge required for CI).

const SCAFFOLD_RE = /\b(WHAT|WHY|HOW)\s*:/i;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]{2,}/g;

function extractIdents(text) {
    const s = new Set();
    for (const m of String(text || '').matchAll(IDENT_RE)) {
        const t = m[0];
        // Drop common English stop-ish words that appear in prose.
        if (
            /^(the|and|for|with|from|this|that|when|then|else|null|undefined|true|false|return|await|async|const|let|var|function|class|import|export|what|why|how)$/i.test(
                t,
            )
        ) {
            continue;
        }
        s.add(t);
    }
    return s;
}

/**
 * Score one formatted suggestion against its original.
 * @returns {{ parse_ok, non_empty, no_scaffold, ident_recall, length_ok, auto_pass }}
 */
function scoreOne(original, formatted) {
    const origText = original?.suggestionContent || '';
    const outText = formatted?.suggestionContent || '';

    if (!formatted || typeof outText !== 'string') {
        return {
            parse_ok: false,
            non_empty: false,
            no_scaffold: false,
            ident_recall: 0,
            length_ok: false,
            auto_pass: false,
        };
    }

    const nonEmpty = outText.trim().length > 0;
    const noScaffold = !SCAFFOLD_RE.test(outText);
    const origIdents = extractIdents(origText);
    const outIdents = extractIdents(outText);
    let kept = 0;
    for (const id of origIdents) if (outIdents.has(id)) kept++;
    const identRecall = origIdents.size ? kept / origIdents.size : 1;
    const lengthOk =
        nonEmpty &&
        (origText.length === 0 || outText.length <= 3 * origText.length);

    const autoPass =
        nonEmpty && noScaffold && identRecall >= 0.5 && lengthOk;

    return {
        parse_ok: true,
        non_empty: nonEmpty,
        no_scaffold: noScaffold,
        ident_recall: identRecall,
        length_ok: lengthOk,
        auto_pass: autoPass,
    };
}

/**
 * Aggregate over a PR (or batch).
 * @param {Array} findings original findings
 * @param {Map|Object} formattedMap index → { suggestionContent, improvedCode }
 * @param {{ parseOk: boolean }} meta
 */
function computeMetrics(findings, formattedMap, meta = {}) {
    const get = (i) => {
        if (formattedMap instanceof Map) return formattedMap.get(i);
        return formattedMap?.[i];
    };

    if (meta.parseOk === false || findings.length === 0) {
        return {
            n: findings.length,
            parse_ok: meta.parseOk !== false && findings.length === 0,
            parse_fail: meta.parseOk === false ? 1 : 0,
            auto_pass: 0,
            auto_pass_rate: findings.length === 0 ? 1 : 0,
            ident_recall_mean: 0,
            no_scaffold_rate: 0,
            non_empty_rate: 0,
        };
    }

    let auto = 0;
    let identSum = 0;
    let noScaf = 0;
    let nonEmpty = 0;
    let scored = 0;

    for (let i = 0; i < findings.length; i++) {
        const fmt = get(i);
        // Prod skips missing indices (keeps original). Count as non-formatted.
        if (!fmt) {
            scored++;
            // original may still have WHAT/WHY/HOW — fail auto
            const s = scoreOne(findings[i], {
                suggestionContent: findings[i].suggestionContent,
            });
            identSum += s.ident_recall;
            if (s.no_scaffold) noScaf++;
            if (s.non_empty) nonEmpty++;
            // Missing format: not an auto pass of the formatter
            continue;
        }
        const s = scoreOne(findings[i], fmt);
        scored++;
        identSum += s.ident_recall;
        if (s.auto_pass) auto++;
        if (s.no_scaffold) noScaf++;
        if (s.non_empty) nonEmpty++;
    }

    const n = findings.length || 1;
    return {
        n: findings.length,
        parse_ok: true,
        parse_fail: 0,
        auto_pass: auto,
        auto_pass_rate: auto / n,
        ident_recall_mean: identSum / n,
        no_scaffold_rate: noScaf / n,
        non_empty_rate: nonEmpty / n,
        scored,
    };
}

module.exports = {
    SCAFFOLD_RE,
    extractIdents,
    scoreOne,
    computeMetrics,
};
