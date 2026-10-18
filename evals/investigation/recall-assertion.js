/**
 * Finder-RECALL assertion for the current review engine.
 *
 * Did what the review ships cover the PR's known bugs? It judge-matches each
 * `goldenComments` entry against the review's `findings` (recall-judge.js) and
 * reports recall = matched / goldens, precision, and the same recall over the
 * finder's loop output (`loopRecall`, before the steps that follow it).
 *
 * Pass/fail: by default a measurement (always passes, score = recall) so the suite
 * never red-flags on PR-level noise. Set RECALL_THRESHOLD (0..1) to gate — e.g. a
 * regression case "must find the SSRF" runs with RECALL_THRESHOLD=1.
 */
const { parseOutput } = require('./parse-output');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');

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

// Each known bug's best match among `candidates`: the finding the judge is
// surest of (at our confidence floor). See the comment at the call.
async function bestMatches(apiKey, goldens, candidates) {
    const best = new Array(goldens.length).fill(-1);
    const bestConfidence = new Array(goldens.length).fill(0);
    for (let gi = 0; gi < goldens.length; gi++) {
        const goldenText = typeof goldens[gi] === 'string' ? goldens[gi] : goldens[gi].comment;
        for (let fi = 0; fi < candidates.length; fi++) {
            // Nothing outranks a certain match: stop judging this known bug.
            if (bestConfidence[gi] >= 1) break;
            // eslint-disable-next-line no-await-in-loop
            const { match, confidence } = await matchCommentDetailed(apiKey, goldenText, candidates[fi]);
            if (match && confidence > bestConfidence[gi]) {
                bestConfidence[gi] = confidence;
                best[gi] = fi;
            }
        }
    }
    return best;
}

module.exports = async (output, context) => {
    const parsed = parseOutput(output);
    if (!parsed) {
        return { pass: false, score: 0, reason: 'Failed to parse provider output.' };
    }
    const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const goldens = asArray(context && context.vars && context.vars.goldenComments);
    if (!goldens.length) {
        // A control case (a set's PR built with nothing to find): no recall, and
        // every finding the review ships is noise.
        return {
            pass: findings.length === 0,
            score: findings.length === 0 ? 1 : 0,
            reason: `control: nothing to find, ${findings.length} finding${findings.length === 1 ? '' : 's'} shipped`,
            metadata: { control: true, recall: null, precision: null, matched: 0, goldens: 0, tpFindings: 0, fpFindings: findings.length, findings: findings.length, goldenResults: [] },
        };
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
    // Judge every (golden, finding) pair so we get BOTH:
    //   recall    — goldens covered by a finding  (did we catch the real bugs?)
    //   precision — findings that are a golden's match, of all findings
    //               (is what we post real, not noise?)
    // Each known bug is matched by ONE finding: the one the judge is surest of
    // (as Martian's step3_judge_comments.py keeps the best-confidence match, and
    // feat/improve-harness-to-big-models b2575151d after it). Two findings of
    // the same bug count one hit and one false positive; before, both counted
    // as hits and a repeated finding raised precision. Every pair is judged,
    // since the best match is only known after all of them. The match floor is
    // ours (MATCH_CONFIDENCE in recall-judge.js).
    const best = await bestMatches(apiKey, goldens, candidates);
    const goldenHit = best.map((fi) => fi >= 0);
    // Reported next to the gated number: the same known bugs against what the
    // finder's loops returned, before the stage's later steps.
    const loopFindings = Array.isArray(parsed.loopFindings) ? parsed.loopFindings : null;
    const loopMatched = loopFindings
        ? (await bestMatches(apiKey, goldens, loopFindings.map(findingText))).filter((fi) => fi >= 0).length
        : null;
    const findingHit = candidates.map((_, fi) => best.includes(fi));

    const matched = goldenHit.filter(Boolean).length; // goldens covered (recall TP)
    const tpFindings = findingHit.filter(Boolean).length; // findings that are a golden's match
    const fpFindings = candidates.length - tpFindings; // findings that are no golden's match

    const missed = goldens
        .filter((_, gi) => !goldenHit[gi])
        .map((g) => String(typeof g === 'string' ? g : g.comment));

    const recall = matched / goldens.length;
    // A finding that is the match of two goldens counts two hits.
    const precision = matched + fpFindings ? matched / (matched + fpFindings) : 0;
    const f1 = recall + precision ? (2 * recall * precision) / (recall + precision) : 0;

    const reason =
        `recall ${matched}/${goldens.length} (${Math.round(recall * 100)}%) · ` +
        `precision ${matched}/${matched + fpFindings} (${Math.round(precision * 100)}%) · ` +
        `F1 ${f1.toFixed(2)}` +
        (missed.length ? ` · missed: ${missed.map((m) => m.slice(0, 55)).join(' | ')}` : '');
    return {
        pass: recall >= RECALL_THRESHOLD,
        score: recall,
        reason,
        metadata: {
            recall, loopRecall: loopMatched === null ? null : loopMatched / goldens.length, loopFindings: loopFindings ? loopFindings.length : null, precision, f1, matched, goldens: goldens.length, toolCalls: Array.isArray(parsed.trace?.toolCalls) ? parsed.trace.toolCalls.length : null, tpFindings, fpFindings, findings: candidates.length,
            // Which known bugs were found, by text: lets the nightly name the bugs
            // it found last green night and missed tonight, not just a number.
            goldenResults: goldens.map((g, gi) => ({ golden: String(typeof g === 'string' ? g : g.comment), found: goldenHit[gi] })),
        },
    };
};
