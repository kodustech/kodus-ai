#!/usr/bin/env node
// The nightly verdict for kody-rules: one run against its floor, and a second
// run before anyone is alerted (the finder's confirm-gate.js, for this eval).
//
//   node evals/kody-rules/nightly-verdict.js --first=<result.json> [--confirm=<result.json>]
//        [--previous=<state.json>] --out=<final.json> --state=<state.json>
//
// Results come from `real-agent.js --output`. A first run below the floor is
// pooled with the confirming run (sites and files summed), and only the pooled
// rates decide. Verdicts:
//   pass         the first run is at or above both floors
//   oscillation  the first fell below, the pooled rates did not
//   regression   the pooled rates are below a floor, and the last measured night
//                was not, or it got worse by more than WORSE (mentions people)
//   still-red    below, as the last measured night already was (no mention)
//   infra        a run did not measure (key, quota, crash): never a quality result
//
// Writes the final result (with `verdict`), the state the next night compares
// with, and, under GitHub Actions, outputs for the message. Exit 0 always: the
// verdict travels in the outputs and the quality signal, not the exit code.
const fs = require('fs');

// A drop already alerted pings again only when the pooled recall falls this
// much further: about one binomial SE over the set's 43 sites.
const WORSE = 0.04;

function measured(result) {
    return Boolean(result && result.sites > 0 && result.totalRuns > 0 && result.erroredRuns / result.totalRuns < 0.5);
}

function belowFloor(result) {
    const { floors } = result;
    return result.occurrenceRecall < floors.occurrenceRecall || (result.specificity ?? 1) < floors.specificity;
}

function pool(a, b) {
    const sum = (k) => (a[k] || 0) + (b[k] || 0);
    const sites = sum('sites');
    const flagged = sum('flagged');
    const cleanFiles = sum('cleanFiles');
    return {
        ...a,
        runs: sum('runs'),
        sites,
        caught: sum('caught'),
        flagged,
        offSite: sum('offSite'),
        cleanFiles,
        falseAlarmFiles: sum('falseAlarmFiles'),
        occurrenceRecall: sites ? sum('caught') / sites : null,
        linePrecision: flagged ? (flagged - sum('offSite')) / flagged : null,
        specificity: cleanFiles ? (cleanFiles - sum('falseAlarmFiles')) / cleanFiles : null,
        tokens: Object.fromEntries(Object.keys(a.tokens || {}).map((k) => [k, (a.tokens[k] || 0) + ((b.tokens || {})[k] || 0)])),
        erroredRuns: sum('erroredRuns'),
        totalRuns: sum('totalRuns'),
        pooled: true,
    };
}

function decide({ first, confirm, previous }) {
    if (!measured(first)) return { verdict: 'infra', final: first || null, mention: false };
    if (!belowFloor(first)) return { verdict: 'pass', final: first, mention: false };
    if (!measured(confirm)) return { verdict: 'infra', final: first, mention: false };
    const final = pool(first, confirm);
    if (!belowFloor(final)) return { verdict: 'oscillation', final, mention: false };
    const wasRed = previous && (previous.verdict === 'regression' || previous.verdict === 'still-red');
    const worse = wasRed && final.occurrenceRecall < previous.occurrenceRecall - WORSE;
    if (wasRed && !worse) return { verdict: 'still-red', final, mention: false };
    return { verdict: 'regression', final, mention: true };
}

const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);

function message(verdict, final) {
    const line = final ? `${pct(final.occurrenceRecall)} of known rule violations flagged (floor ${pct(final.floors.occurrenceRecall)}), ${pct(final.specificity)} of clean files left alone` : '';
    return {
        regression: { status: 'failure', title: '🔴 Kody Rules dropped below the floor', description: `${line}. Confirmed by a second run.` },
        'still-red': { status: 'failure', title: '🔴 Kody Rules still below the floor', description: `${line}. Already alerted; no change made it better.` },
        oscillation: { status: 'success', title: '🟡 Kody Rules dipped below the floor, the second run passed', description: line },
        infra: { status: 'cancelled', title: '⚪ Kody Rules not measured', description: 'A run did not measure (key, quota or crash); see the run log. Not a quality result.' },
        pass: { status: 'success', title: '🟢 Kody Rules above the floor', description: line },
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
    if (!arg('first') || !out || !statePath) {
        console.error('usage: nightly-verdict.js --first=<result.json> [--confirm=<result.json>] [--previous=<state.json>] --out=<final.json> --state=<state.json>');
        return 2;
    }
    const { verdict, final, mention } = decide({ first: readJson(arg('first')), confirm: readJson(arg('confirm')), previous: readJson(arg('previous')) });
    fs.writeFileSync(out, `${JSON.stringify({ ...(final || {}), verdict }, null, 2)}\n`);
    fs.writeFileSync(statePath, `${JSON.stringify({ verdict, occurrenceRecall: final?.occurrenceRecall ?? null, specificity: final?.specificity ?? null }, null, 2)}\n`);
    const msg = message(verdict, final);
    console.log(`${verdict}${mention ? ' (mention)' : ''}: ${msg.title} — ${msg.description}`);
    if (process.env.GITHUB_OUTPUT) {
        const lines = { verdict, mention: String(mention), status: msg.status, title: msg.title, description: msg.description, post: String(verdict !== 'pass') };
        fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
    }
    return 0;
}

if (require.main === module) process.exit(main());

module.exports = { decide, pool, WORSE };
