#!/usr/bin/env node
// Freezes the finder's output for the stage evals after it (evals/funnel):
// runs the real finder (evals/investigation/agent-provider.js) on the nightly's
// PRs and records every candidate the verifier judged, its verdicts, whether it
// survived, and the known bug it matches (evals/funnel/known-bugs.js), read by
// the recall judge with the nightly's prompt.
//
//   node evals/funnel/snapshot.js --model=<id> [--cases=<id,id>] [--concurrency=N]
//
// Writes evals/funnel/snapshot/<model>.json. Spends one finder run per PR plus
// a judge call per candidate and known bug until the first match. Run by hand,
// then commit: the stages measure on this input, not on a fresh finder run, so
// a stage's number moves only when the stage does.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { execFileSync } = require('child_process');
const { knownBugs, datasetFor } = require('./known-bugs');

const ROOT = path.join(__dirname, '..', '..');
const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model;
if (!MODEL) {
    console.error('usage: node evals/funnel/snapshot.js --model=<id> [--cases=<id,id>] [--concurrency=N]');
    process.exit(2);
}

process.env.RECALL_MODEL = MODEL;
const Provider = require(path.join(ROOT, 'evals/investigation/agent-provider'));
const LIGHT_CASES = require(path.join(ROOT, 'evals/investigation/recall-tests')).CASE_SETS.light;
const { matchComment, loadJudgeKey, JUDGE_MODEL } = require(path.join(ROOT, 'evals/investigation/recall-judge'));
const { LlmVerifier } = require(path.join(ROOT, 'libs/code-review/infrastructure/agents/core/verifier.agent.ts'));

// Every candidate the verifier judged in this case, with its verdicts in order
// (the evidence gate judges some twice). Observed, not changed.
const judged = new AsyncLocalStorage();
const verifyOriginal = LlmVerifier.prototype.verify;
LlmVerifier.prototype.verify = async function observedVerify(candidate, ctx) {
    const verdict = await verifyOriginal.call(this, candidate, ctx);
    const store = judged.getStore();
    if (store) {
        if (!store.has(candidate)) store.set(candidate, []);
        store.get(candidate).push({ keep: !!verdict.keep, rationale: String(verdict.rationale || '').slice(0, 600) });
    }
    return verdict;
};

// The text the recall judge reads for a finding (evals/investigation/recall-assertion.js).
const findingText = (f) => [f.oneSentenceSummary, f.suggestionContent, f.label, f.relevantFile].filter(Boolean).join(' — ');
const key = (f) => `${String(f.relevantFile || '').replace(/^\/+/, '')}|${String(f.suggestionContent || '').slice(0, 80)}`;
const FIELDS = ['relevantFile', 'relevantLinesStart', 'relevantLinesEnd', 'language', 'label', 'severity', 'confidence', 'oneSentenceSummary', 'suggestionContent', 'existingCode', 'improvedCode'];
const pick = (f) => Object.fromEntries(FIELDS.filter((k) => f[k] !== undefined).map((k) => [k, f[k]]));


async function snapshotCase(provider, caseId, judgeKey) {
    const store = new Map();
    const vars = datasetFor(caseId);
    const r = await judged.run(store, () => provider.callApi(JSON.stringify(vars), { vars }, {}));
    if (!r.output) throw new Error(String(r.error || 'the finder returned no output').slice(0, 200));
    const kept = new Set((JSON.parse(r.output).findings || []).map(key));
    const bugs = knownBugs(caseId);
    const candidates = [];
    for (const [finding, verdicts] of store) {
        let bug = null;
        for (const b of bugs) {
            // eslint-disable-next-line no-await-in-loop
            if (await matchComment(judgeKey, b.text, findingText(finding))) {
                bug = b.index;
                break;
            }
        }
        candidates.push({ finding: pick(finding), verdicts, kept: kept.has(key(finding)), bug });
    }
    return { caseId, knownBugs: bugs.length, candidates };
}

async function main() {
    const judgeKey = loadJudgeKey();
    if (!judgeKey) {
        console.error(`no key for the judge (${JUDGE_MODEL}); set JUDGE_API_KEY`);
        return 2;
    }
    const caseIds = args.cases ? String(args.cases).split(',') : LIGHT_CASES;
    const provider = new Provider({ config: { label: `funnel-snapshot-${MODEL}`, provider: 'tier0', model: MODEL } });
    // Each PR is kept as it finishes, so a run that fails on one PR is resumed
    // instead of repeated: rerun the same command and only the missing PRs run.
    const partial = path.join(__dirname, 'snapshot', `.partial-${MODEL.replace(/[^\w.@-]+/g, '-')}`);
    fs.mkdirSync(partial, { recursive: true });
    const cases = new Array(caseIds.length);
    const failed = [];
    let next = 0;
    const worker = async () => {
        while (next < caseIds.length) {
            const i = next++;
            const done = path.join(partial, `${caseIds[i]}.json`);
            if (fs.existsSync(done)) {
                cases[i] = JSON.parse(fs.readFileSync(done, 'utf8'));
                continue;
            }
            try {
                // eslint-disable-next-line no-await-in-loop
                cases[i] = await snapshotCase(provider, caseIds[i], judgeKey);
                fs.writeFileSync(done, JSON.stringify(cases[i]));
                const c = cases[i];
                console.log(`${caseIds[i]}: ${c.candidates.length} candidates, ${c.candidates.filter((x) => x.kept).length} kept, ${new Set(c.candidates.filter((x) => x.bug !== null).map((x) => x.bug)).size}/${c.knownBugs} known bugs found`);
            } catch (error) {
                failed.push(caseIds[i]);
                console.error(`${caseIds[i]}: ${String(error.message || error).slice(0, 200)}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 4) }, worker));
    if (failed.length) {
        console.error(`not written: ${failed.length} of ${caseIds.length} PRs failed (see above); a snapshot must hold every PR. The others are kept: rerun to resume.`);
        return 2;
    }
    const out = path.join(__dirname, 'snapshot', `${MODEL.replace(/[^\w.@-]+/g, '-')}.json`);
    const snapshot = {
        model: MODEL,
        judge: JUDGE_MODEL,
        builtAt: new Date().toISOString().slice(0, 10),
        builtOn: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
        knownBugsFrom: require('./known-bugs').SOURCE,
        cases,
    };
    fs.writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
    fs.rmSync(partial, { recursive: true, force: true });
    console.log(`wrote ${path.relative(ROOT, out)}`);
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });
