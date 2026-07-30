/**
 * Finder-RECALL assertion for the current review engine.
 *
 * Unlike investigation-assertion.js (which checks tool-use behavior), this scores
 * what actually matters: did the finder's findings cover the golden bugs? It
 * judge-matches each `goldenComments` entry against the agent's `findings` (Sonnet)
 * and reports recall = matched / goldens.
 *
 * Pass/fail: by default a measurement (always passes, score = recall) so the suite
 * never red-flags on PR-level noise. Set RECALL_THRESHOLD (0..1) to gate — e.g. a
 * regression case "must find the SSRF" runs with RECALL_THRESHOLD=1.
 */
const { parseOutput } = require('./parse-output');
const { loadJudgeKey, matchComment } = require('./recall-judge');

function asArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
        try {
            return JSON.parse(v);
        } catch {
            return [];
        }
    }
    return [];
}

function findingText(f) {
    if (!f || typeof f !== 'object') return String(f || '');
    return [f.oneSentenceSummary, f.suggestionContent, f.label, f.relevantFile]
        .filter(Boolean)
        .join(' — ');
}

const RECALL_THRESHOLD = Number(process.env.RECALL_THRESHOLD || 0);

const STOPWORDS = /^(this|self|true|false|null|none|with|that|when|then|from|will|have|been|which|these|there|where|while|should|could|would|because|without|value|values|method|function|class|object|return|input|output|param|params|error|check|other|using|used|into|only|when|note|here)$/i;

// Pull distinctive code identifiers out of a golden's prose so we can check
// whether the code it refers to was in the corpus the finder actually saw.
function extractCodeTokens(text) {
    const s = String(text || '');
    const tokens = new Set();
    for (const m of s.matchAll(/`([^`]{2,60})`/g)) tokens.add(m[1]);          // `code`
    for (const m of s.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]{3,})\s*\(/g)) tokens.add(m[1]); // foo(
    for (const m of s.matchAll(/\b([a-zA-Z]+[a-z][A-Z][a-zA-Z0-9]{2,})\b/g)) tokens.add(m[1]); // camelCase
    for (const m of s.matchAll(/\b([a-z][a-z0-9]*_[a-z0-9_]{2,})\b/g)) tokens.add(m[1]); // snake_case
    for (const m of s.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]+)\b/g)) tokens.add(m[1]); // a.b
    return [...tokens]
        .map((t) => t.trim())
        .filter((t) => t.length >= 4 && !STOPWORDS.test(t));
}

// Flatten the readFile corpus (what the finder could see) into one searchable blob.
function corpusText(vars) {
    try {
        const replay = JSON.parse((vars && vars.toolReplay) || '{}');
        return (replay.readFile || []).map((e) => String(e.result || '')).join('\n');
    } catch {
        return '';
    }
}

// Was the code this golden refers to present in the corpus?
//   present=true  → finder saw it and didn't name it (real recognition miss)
//   present=false → corpus lacked it (replay artifact or genuinely cross-file)
//   present=null  → no extractable identifiers (needs the LLM fallback to judge)
function codeInCorpus(goldenText, corpus) {
    const tokens = extractCodeTokens(goldenText);
    if (!tokens.length) return { present: null, hits: [] };
    const hits = tokens.filter((t) => corpus.includes(t));
    return { present: hits.length > 0, hits };
}

module.exports = async (output, context) => {
    const parsed = parseOutput(output);
    if (!parsed) {
        return { pass: false, score: 0, reason: 'Failed to parse provider output.' };
    }
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const goldens = asArray(context && context.vars && context.vars.goldenComments);
    if (!goldens.length) {
        return { pass: true, score: 1, reason: 'No goldenComments in case — nothing to score.' };
    }

    const apiKey = loadJudgeKey();
    if (!apiKey) {
        return {
            pass: false,
            score: 0,
            reason: 'No ANTHROPIC_API_KEY (judge) — set it in env or ~/.kodus-dev/config.',
        };
    }

    const candidates = findings.map(findingText);
    const corpus = corpusText(context && context.vars);

    // Loop fidelity (replay hit-rate): of the tool calls the agent actually made,
    // how many could the replay serve? Low hit-rate = the agent explored beyond the
    // recording and reflected on empty results → that PR's recall is unreliable.
    const trace = parsed.trace || {};
    const unserved = Array.isArray(trace.unexpectedToolCalls) ? trace.unexpectedToolCalls.length : 0;
    // Denominator = the replay's OWN total calls (served + unserved), not the
    // agent's toolCalls array (which undercounts → could go negative).
    const totalCalls = typeof trace.replayCalls === 'number' ? trace.replayCalls : unserved;
    const hitRate = totalCalls ? Math.max(0, (totalCalls - unserved) / totalCalls) : 1;
    // Judge every (golden, finding) pair so we get BOTH:
    //   recall    — goldens covered by >=1 finding  (did we catch the real bugs?)
    //   precision — findings that hit >=1 golden     (is what we post real, not noise?)
    // Skip a pair only when both sides are already decided.
    const goldenHit = new Array(goldens.length).fill(false);
    const findingHit = new Array(candidates.length).fill(false);
    for (let gi = 0; gi < goldens.length; gi++) {
        const goldenText = typeof goldens[gi] === 'string' ? goldens[gi] : goldens[gi].comment;
        for (let fi = 0; fi < candidates.length; fi++) {
            if (goldenHit[gi] && findingHit[fi]) continue;
            // eslint-disable-next-line no-await-in-loop
            if (await matchComment(apiKey, goldenText, candidates[fi])) {
                goldenHit[gi] = true;
                findingHit[fi] = true;
            }
        }
    }

    const matched = goldenHit.filter(Boolean).length; // goldens covered (recall TP)
    const tpFindings = findingHit.filter(Boolean).length; // findings that hit a golden
    const fpFindings = candidates.length - tpFindings; // findings that hit nothing

    const missed = [];
    for (let gi = 0; gi < goldens.length; gi++) {
        if (goldenHit[gi]) continue;
        const t = typeof goldens[gi] === 'string' ? goldens[gi] : goldens[gi].comment;
        missed.push({ text: String(t), fair: codeInCorpus(t, corpus) });
    }

    // Fairness: of the missed goldens, how many had their code in the corpus the
    // finder actually saw (real recognition miss) vs absent (replay artifact /
    // cross-file) vs untestable (no identifiers → LLM fallback).
    const realMiss = missed.filter((m) => m.fair.present === true).length;
    const artifact = missed.filter((m) => m.fair.present === false).length;
    const untestable = missed.filter((m) => m.fair.present === null).length;

    const recall = matched / goldens.length;
    const precision = candidates.length ? tpFindings / candidates.length : 0;
    const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;
    // Fair recall = TP / (TP + recognition-misses) — excludes replay artifacts.
    const fairDenom = matched + realMiss + untestable;
    const fairRecall = fairDenom ? matched / fairDenom : recall;

    const reason =
        `recall ${matched}/${goldens.length} (${Math.round(recall * 100)}%) · ` +
        `precision ${tpFindings}/${candidates.length} (${Math.round(precision * 100)}%) · ` +
        `F1 ${f1.toFixed(2)} · ` +
        `fair-recall ${Math.round(fairRecall * 100)}% · ` +
        `loop-fidelity ${Math.round(hitRate * 100)}% (${totalCalls - unserved}/${totalCalls} served)` +
        (missed.length
            ? ` · missed[real=${realMiss} artifact=${artifact} untestable=${untestable}]: ` +
              missed.map((m) => `${m.text.slice(0, 55)}${m.fair.present === false ? ' «not-in-corpus»' : m.fair.present === null ? ' «no-tokens»' : ''}`).join(' | ')
            : '');
    return {
        pass: recall >= RECALL_THRESHOLD,
        score: recall,
        reason,
        metadata: { recall, precision, f1, fairRecall, hitRate, totalCalls, unserved, matched, goldens: goldens.length, tpFindings, fpFindings, findings: candidates.length, realMiss, artifact, untestable },
    };
};
