#!/usr/bin/env node
// business-logic-requirements: production's BusinessLogicValidationStage on PRs
// whose answer per requirement is known, scored on the verdict it publishes
// (evals/business-logic/production-stage.js).
//
//   node evals/business-logic-requirements/run.js [--model=<id>] [--gate] [--output=<result.json>] [--limit=N] [--verify]
//
// Each case is a PR, its diff, the Jira ticket it closes (with its parent or
// sub-tasks), the files already in the repository, and the gold state of each
// requirement (cases.json, files/). A requirement is found in the verdict by
// the case's pattern, and is right when its state is one the gold accepts.
//
// The metric is the share of the requirements a PR does that the stage does
// not call a gap (missing, partial): a false gap tells an author to redo done
// work (#1725, #1884, #2019). The share of the gaps it calls one has a floor of
// its own (targets.json `gapsFloor`).
//
// Exit: 0 pass, 1 below a floor (--gate), 2 did not measure (evals/README.md).
const fs = require('fs');
const path = require('path');
const { orgRouteOrExit } = require('../shared/model-route');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model || 'deepseek-v4-flash@fireworks';
const TARGET = (require('./targets.json').models || {})[MODEL] || {};
const cases = require('./cases.json').slice(0, args.limit ? Number(args.limit) : undefined);
const FILES = path.join(__dirname, 'files');
const GAP_STATES = ['missing', 'partial'];

// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
const ROUTE = orgRouteOrExit(MODEL);

// What the gold says of a requirement: the PR does it, leaves it out, or neither.
function goldClass(gold) {
    const gap = gold.accept.some((s) => GAP_STATES.includes(s));
    if (gold.accept.includes('met')) return gap ? 'other' : 'done';
    return gap ? 'gap' : 'other';
}

// The verdict's requirements, against the gold.
function score(c, decided) {
    const requirements = decided?.kind === 'validated' ? decided.checks.flatMap((check) => check.verdict.requirements || []) : [];
    const used = new Set();
    const patterns = c.gold.map((gold) => new RegExp(gold.match, 'i'));
    const items = c.gold.map((gold, g) => {
        // The requirement this gold names: of the ones its pattern matches, the
        // one the fewest other golds match, so the verdict's order never decides.
        const candidates = requirements
            .map((r, i) => ({ r, i, others: patterns.filter((p, j) => j !== g && p.test(r.requirement)).length }))
            .filter(({ r, i }) => !used.has(i) && patterns[g].test(r.requirement))
            .sort((x, y) => x.others - y.others);
        const found = candidates[0]?.r;
        if (candidates[0]) used.add(candidates[0].i);
        const state = found ? found.state : 'not listed';
        return {
            gold: goldClass(gold),
            flagged: GAP_STATES.includes(state),
            // A requirement the verdict leaves out was not judged at all: it
            // is no credit for done work, and a gap missed.
            unlisted: !found && !gold.absentOk,
            what: `/${gold.match}/ ${state}, expected ${gold.accept.join(' or ')}${gold.absentOk ? ' or not listed' : ''}`,
            ok: found ? gold.accept.includes(state) : !!gold.absentOk,
        };
    });
    // A requirement the ticket never stated, called a gap, is a false gap (#1725).
    const invented = c.onlyGold
        ? requirements
              .filter((_, i) => !used.has(i))
              .map((r) => ({ gold: 'done', flagged: GAP_STATES.includes(r.state), what: `invented "${r.requirement.slice(0, 80)}" ${r.state}`, ok: false }))
        : [];
    const detail = [...items, ...invented];
    if (decided?.kind !== 'validated') detail.unshift({ gold: 'other', flagged: false, what: `outcome ${decided?.kind || 'none'}${decided?.reason ? ` (${decided.reason})` : ''}, expected validated`, ok: false });
    return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail };
}

async function main() {
    const harness = require('../business-logic/production-stage');
    // The stage's ObservabilityService registers itself as the LLM port when it
    // is built; the count registers after it, so every call is counted.
    harness.observability();
    countTokens();
    const world = { current: null };
    const services = await harness.startServices(world);
    const results = [];
    // `unlisted`: done requirements the verdict left out, counted against it.
    const confusion = { tp: 0, fn: 0, tn: 0, fp: 0, unlisted: 0 };
    let errored = 0;
    try {
        for (const c of cases) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const run = await harness.reviewCase(world, c, { filesDir: FILES, verifyAnalyzerResult: !!args.verify, storedConfig: ROUTE.storedConfig });
                if (run.outcome?.kind === 'error') throw new Error(run.outcome.message);
                // The judge's call failed (a key, a quota, a timeout): nothing was judged.
                const failedCall = run.judgeFailures.find((f) => f.reason === 'analyzer_failure');
                if (failedCall) throw new Error(`the judge's call failed: ${failedCall.cause}`);
                const scored = score(c, run.decided);
                for (const d of scored.detail) {
                    if (d.gold === 'gap') confusion[d.flagged ? 'tp' : 'fn'] += 1;
                    if (d.gold === 'done') confusion[d.unlisted ? 'unlisted' : d.flagged ? 'fp' : 'tn'] += 1;
                }
                results.push({
                    id: c.id,
                    checks: c.checks,
                    hits: scored.hits,
                    total: scored.total,
                    detail: scored.detail.map(({ what, ok }) => ({ what, ok })),
                    // The verdict as the stage decided it, to read a miss against.
                    verdict: (run.decided?.checks || []).flatMap((check) => check.verdict.requirements || []).map((r) => ({
                        requirement: r.requirement,
                        state: r.state,
                        ...(r.judgedState ? { judgedState: r.judgedState } : {}),
                        note: r.note,
                        evidence: (r.evidence || []).map((e) => `${e.file}:${e.line ?? ''}`),
                    })),
                });
                console.log(`  ${c.id.padEnd(42)} ${scored.hits}/${scored.total}  ${scored.detail.filter((d) => !d.ok).map((d) => `✗ ${d.what}`).join('  ')}`);
            } catch (error) {
                errored += 1;
                console.error(`  ${c.id}: ${String(error.message || error).slice(0, 240)}`);
                results.push({ id: c.id, checks: c.checks, hits: 0, total: 0, unmeasured: true });
            }
        }
    } finally {
        await services.close();
    }

    const ratio = (a, b) => (b ? a / b : null);
    const doneNotFlagged = ratio(confusion.tn, confusion.tn + confusion.fp + confusion.unlisted);
    const gapsCaught = ratio(confusion.tp, confusion.tp + confusion.fn);
    const result = {
        eval: 'business-logic-requirements',
        question: evalQuestion('evals/business-logic-requirements'),
        model: MODEL,
        runs: 1,
        metric: { name: 'of the requirements a PR does, not called a gap', value: doneNotFlagged, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        gaps: { name: 'of the requirements a PR leaves out, called a gap', value: gapsCaught, floor: TARGET.gapsFloor ?? null, baseline: TARGET.gapsObserved ?? null },
        confusion,
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
    console.log(
        `business-logic-requirements: done work not called a gap ${confusion.tn}/${confusion.tn + confusion.fp + confusion.unlisted} (${pct(doneNotFlagged)}${confusion.unlisted ? `, ${confusion.unlisted} left out` : ''}) · gaps caught ${confusion.tp}/${confusion.tp + confusion.fn} (${pct(gapsCaught)})${args.verify ? ' (verify pass on)' : ''} · ${errored} of ${cases.length} cases did not measure`,
    );
    if (errored > cases.length * 0.05) {
        console.error(`not measured: ${errored} of ${cases.length} cases failed to run (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (!args.gate) return 0;
    if (result.metric.floor === null && result.gaps.floor === null) {
        console.log(`ungated: no floor for ${MODEL} in evals/business-logic-requirements/targets.json (measured, not compared)`);
        return 0;
    }
    const below = [
        result.metric.floor !== null && doneNotFlagged < result.metric.floor && `done work not called a gap ${pct(doneNotFlagged)} < ${pct(result.metric.floor)}`,
        result.gaps.floor !== null && gapsCaught < result.gaps.floor && `gaps caught ${pct(gapsCaught)} < ${pct(result.gaps.floor)}`,
    ].filter(Boolean);
    if (below.length) {
        console.error(`GATE FAILED: ${below.join('; ')} (evals/business-logic-requirements/targets.json)`);
        return 1;
    }
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
