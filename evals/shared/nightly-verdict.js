#!/usr/bin/env node
// The nightly verdict for an eval of evals/nightly-evals.js: one run against
// its floor, and a second run before anyone is alerted (the finder's
// confirm-gate.js, for any eval writing the shared result).
//
//   node evals/shared/nightly-verdict.js --eval=<id> --first=<result.json> [--confirm=<result.json>]
//        [--previous=<state.json>] --out=<final.json> --state=<state.json>
//
// A first run below the floor is pooled with the confirming run over the cases
// both measured (poolCases), and only the pooled metric decides:
//   pass         the first run is at or above the floor
//   oscillation  the first fell below, the pooled metric did not
//   regression   the pooled metric is below, and the last measured night was
//                not, or it fell more than WORSE (mentions people)
//   still-red    below, as the last measured night already was (no mention)
//   ungated      measured, but the model has no floor to compare with (yellow,
//                as the finder's gate does): never reported as a pass
//   infra        a run did not measure: never a quality result
//
// Writes the final result (with `verdict`), the state the next night compares
// with (an unmeasured night keeps the last one), and, under GitHub Actions,
// outputs for the message. Exit 0 always: the verdict travels in the outputs.
const fs = require('fs');
const { poolCases, poolTokens } = require('./eval-result');
const { STAGES } = require('../stages');
const { byId } = require('../nightly-evals');

const WORSE = 0.04;
const INFRA_BUDGET = 0.05; // evals/README.md: up to 5% of cases may go unmeasured

function measured(result) {
    const infra = result?.infra || {};
    return Boolean(result && Array.isArray(result.cases) && result.cases.length && infra.total > 0 && infra.errored / infra.total <= INFRA_BUDGET && Number.isFinite(result.metric?.value));
}

const belowFloor = (result) => Number.isFinite(result.metric.floor) && result.metric.value < result.metric.floor;

function pool(a, b) {
    const cases = poolCases(a.cases, b.cases);
    const hits = cases.reduce((n, c) => n + c.hits, 0);
    const total = cases.reduce((n, c) => n + c.total, 0);
    return {
        ...a,
        runs: (a.runs || 1) + (b.runs || 1),
        metric: { ...a.metric, value: total ? hits / total : null },
        cases,
        tokens: poolTokens(a.tokens, b.tokens),
        infra: { errored: (a.infra?.errored || 0) + (b.infra?.errored || 0), total: (a.infra?.total || 0) + (b.infra?.total || 0) },
        pooled: true,
    };
}

function nextState(verdict, final, previous) {
    if (verdict === 'infra' && previous) return previous;
    return { verdict, value: final?.metric?.value ?? null };
}

function decide({ first, confirm, previous }) {
    if (!measured(first)) return { verdict: 'infra', final: first || null, mention: false };
    if (!Number.isFinite(first.metric.floor)) return { verdict: 'ungated', final: first, mention: false };
    if (!belowFloor(first)) return { verdict: 'pass', final: first, mention: false };
    if (!measured(confirm)) return { verdict: 'infra', final: first, mention: false };
    const final = pool(first, confirm);
    if (!belowFloor(final)) return { verdict: 'oscillation', final, mention: false };
    const wasRed = previous && (previous.verdict === 'regression' || previous.verdict === 'still-red');
    const worse = wasRed && final.metric.value < previous.value - WORSE;
    if (wasRed && !worse) return { verdict: 'still-red', final, mention: false };
    return { verdict: 'regression', final, mention: true };
}

const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);

function message(verdict, final, stageName) {
    const what = final?.metric ? `${pct(final.metric.value)} ${final.metric.name} (floor ${pct(final.metric.floor)})` : '';
    return {
        regression: { status: 'failure', title: `🔴 ${stageName} dropped below the floor`, description: `${what}. Confirmed by a second run.` },
        'still-red': { status: 'failure', title: `🔴 ${stageName} still below the floor`, description: `${what}. Already alerted; no change made it better.` },
        oscillation: { status: 'success', title: `🟡 ${stageName} dipped below the floor, the second run passed`, description: what },
        ungated: { status: 'cancelled', title: `🟡 ${stageName} measured but not compared with a floor`, description: `${final?.metric ? `${pct(final.metric.value)} ${final.metric.name}` : ''}; no floor for ${final?.model || 'this model'} in the eval's targets file.` },
        infra: { status: 'cancelled', title: `⚪ ${stageName} not measured`, description: 'A run did not measure (key, quota or crash); see the run log. Not a quality result.' },
        pass: { status: 'success', title: `🟢 ${stageName} above the floor`, description: what },
    }[verdict];
}

function arg(name) {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : '';
}

function readJson(file) {
    if (!file) return null;
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function main() {
    const out = arg('out');
    const statePath = arg('state');
    const evalId = arg('eval');
    if (!arg('first') || !out || !statePath || !evalId) {
        console.error('usage: nightly-verdict.js --eval=<id> --first=<result.json> [--confirm=<result.json>] [--previous=<state.json>] --out=<final.json> --state=<state.json>');
        return 2;
    }
    const previous = readJson(arg('previous'));
    const { verdict, final, mention } = decide({ first: readJson(arg('first')), confirm: readJson(arg('confirm')), previous });
    fs.writeFileSync(out, `${JSON.stringify({ ...(final || {}), verdict }, null, 2)}\n`);
    fs.writeFileSync(statePath, `${JSON.stringify(nextState(verdict, final, previous), null, 2)}\n`);
    const stageId = byId(evalId)?.stage || evalId;
    const stageName = (STAGES.find((s) => s.id === stageId) || {}).name || stageId;
    const msg = message(verdict, final, stageName);
    console.log(`${verdict}${mention ? ' (mention)' : ''}: ${msg.title} — ${msg.description}`);
    if (process.env.GITHUB_OUTPUT) {
        const lines = { verdict, mention: String(mention), status: msg.status, title: msg.title, description: msg.description, post: String(verdict !== 'pass') };
        fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    }
    return 0;
}

if (require.main === module) process.exit(main());

module.exports = { decide, pool, nextState, WORSE };
