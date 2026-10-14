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

const FENCE_RE = /```/;
const WORD_RE = /[\p{L}\p{N}_]{4,}/gu;

function countSentences(text) {
    const prose = String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, 'x');
    return prose
        .split(/[.!?](?:\s|$)/)
        .filter((s) => s.trim().length > 0).length;
}

/** Share of the title's words (4+ chars) that the body repeats. */
function titleOverlap(title, body) {
    const words = (s) =>
        new Set(
            Array.from(String(s || '').toLowerCase().matchAll(WORD_RE)).map(
                (m) => m[0],
            ),
        );
    const t = words(title);
    if (!t.size) return 0;
    const b = words(body);
    let hit = 0;
    for (const w of t) if (b.has(w)) hit++;
    return hit / t.size;
}

/** Shape of the visible body: length, sentences, fences, title repetition. */
function styleOf(original, outText) {
    return {
        body_chars: outText.length,
        body_sentences: countSentences(outText),
        has_fence: FENCE_RE.test(outText),
        title_overlap: titleOverlap(original?.oneSentenceSummary, outText),
    };
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
    // The comment shows the title above the body, so an identifier the title
    // names is still in front of the reader when the body drops it.
    const outIdents = extractIdents(
        `${original?.oneSentenceSummary || ''} ${outText}`,
    );
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
        ...styleOf(original, outText),
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
    const style = { chars: 0, sentences: 0, fences: 0, overlap: 0 };
    const addStyle = (s) => {
        style.chars += s.body_chars || 0;
        style.sentences += s.body_sentences || 0;
        style.fences += s.has_fence ? 1 : 0;
        style.overlap += s.title_overlap || 0;
    };

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
            addStyle(s);
            // Missing format: not an auto pass of the formatter
            continue;
        }
        const s = scoreOne(findings[i], fmt);
        scored++;
        identSum += s.ident_recall;
        addStyle(s);
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
        body_chars_mean: style.chars / n,
        body_sentences_mean: style.sentences / n,
        fenced_code_rate: style.fences / n,
        title_overlap_mean: style.overlap / n,
        scored,
    };
}

module.exports = {
    SCAFFOLD_RE,
    countSentences,
    titleOverlap,
    extractIdents,
    scoreOne,
    computeMetrics,
};
