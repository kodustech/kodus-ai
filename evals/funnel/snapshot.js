#!/usr/bin/env node
// Freezes the input of each step after the agents (evals/funnel) from one
// production review per nightly PR: evals/investigation/agent-provider.js runs
// production's review stage (evals/shared/review-stage.js), and
// observeTheReview records, without changing them, what each step received:
//   verify     per agent loop, the candidates its first verification pass
//              judged and the files the finder investigated (the evidence
//              gate's input)
//   anchoring  each agent's verified findings, before the path check
//              (mapAgentFindings) and anchorSuggestionsToDiff
//   dedup      what dedupSuggestionStreams received
//   severity   what reclassifyAndFilterSeverity received
// Each finding is labelled with the known bug it matches (known-bugs.js), read
// by the recall judge with the nightly's prompt.
//
//   node evals/funnel/snapshot.js --model=<id> [--cases=<id,id>] [--concurrency=N]
//
// Writes evals/funnel/snapshot/<model>.json. Spends one review per PR plus a
// judge call per distinct finding and known bug until the first match. Run by
// hand, then commit: each stage measures on this input, not on a fresh review,
// so a stage's number moves only when the stage does. What a step derives from
// the PR's data (the changed files, the team's config, the routed model, the
// agent's runner and tools) is not frozen: the stage evals rebuild it with
// production's code from the same data.
const fs = require('fs');
const path = require('path');
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
const { internals } = require(path.join(ROOT, 'evals/investigation/agent-provider'));
const { reviewPullRequest } = require(path.join(ROOT, 'evals/shared/review-stage'));
const LIGHT_CASES = require(path.join(ROOT, 'evals/investigation/recall-tests')).CASE_SETS.light;
const { matchComment, loadJudgeKey, JUDGE_MODEL } = require(path.join(ROOT, 'evals/investigation/recall-judge'));

// The text the recall judge reads for a finding (evals/investigation/recall-assertion.js).
const findingText = (f) => [f.oneSentenceSummary, f.suggestionContent, f.label, f.relevantFile].filter(Boolean).join(' — ');

async function snapshotCase(caseId, route, judgeKey) {
    const vars = datasetFor(caseId);
    const review = await reviewPullRequest({
        pr: internals.prOf(vars),
        team: internals.teamOf(vars),
        route,
        permissionService: internals.evalPermissionService(route.storedConfig),
        observeSteps: true,
    });
    if (review.skipped) throw new Error(`production skipped the review: ${review.skipped}`);
    const failed = review.loops.map((l) => l.result).filter((r) => r?.finishReason === 'error');
    if (failed.length) throw new Error(`an agent loop failed: ${String(failed[0].errorMessage || 'error').slice(0, 160)}`);
    const steps = review.steps || {};

    const bugs = knownBugs(caseId);
    const labels = new Map();
    const bugOf = async (finding) => {
        const text = findingText(finding);
        if (!labels.has(text)) {
            let bug = null;
            for (const b of bugs) {
                // eslint-disable-next-line no-await-in-loop
                if (await matchComment(judgeKey, b.text, text)) {
                    bug = b.index;
                    break;
                }
            }
            labels.set(text, bug);
        }
        return labels.get(text);
    };
    const labelled = async (findings) => {
        const out = [];
        // eslint-disable-next-line no-await-in-loop
        for (const finding of findings || []) out.push({ finding, bug: await bugOf(finding) });
        return out;
    };

    const verify = { loops: [] };
    for (const loop of steps.verify || []) {
        // eslint-disable-next-line no-await-in-loop
        verify.loops.push({ loop: loop.loop, investigated: loop.investigated, candidates: await labelled(loop.candidates) });
    }
    const step = async (name) => (steps[name] ? { candidates: await labelled(steps[name].suggestions) } : { candidates: [] });
    // Anchoring starts at the path check: each agent's verified findings, then
    // the stage's line snap with the Kody Rules it was given.
    const anchoring = { kodyRules: steps.anchorSuggestionsToDiff?.kodyRules || [], agents: [] };
    for (const call of steps.mapper || []) {
        // eslint-disable-next-line no-await-in-loop
        anchoring.agents.push({ params: call.params, candidates: await labelled(call.suggestions) });
    }
    return {
        caseId,
        knownBugs: bugs.length,
        verify,
        anchoring,
        dedup: await step('dedupSuggestionStreams'),
        severity: await step('reclassifyAndFilterSeverity'),
        shipped: review.shipped.length,
    };
}

const found = (c) => new Set(c.verify.loops.flatMap((l) => l.candidates).filter((x) => x.bug !== null).map((x) => x.bug)).size;

async function main() {
    const judgeKey = loadJudgeKey();
    if (!judgeKey) {
        console.error(`no key for the judge (${JUDGE_MODEL}); set JUDGE_API_KEY`);
        return 2;
    }
    const caseIds = args.cases ? String(args.cases).split(',') : LIGHT_CASES;
    const route = internals.resolveRoute({ provider: 'tier0', model: MODEL });
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
                cases[i] = await snapshotCase(caseIds[i], route, judgeKey);
                fs.writeFileSync(done, JSON.stringify(cases[i]));
                const c = cases[i];
                console.log(
                    `${caseIds[i]}: verify ${c.verify.loops.reduce((n, l) => n + l.candidates.length, 0)} · anchoring ${c.anchoring.agents.reduce((n, a) => n + a.candidates.length, 0)} · dedup ${c.dedup.candidates.length} · severity ${c.severity.candidates.length} · shipped ${c.shipped} · ${found(c)}/${c.knownBugs} known bugs found`,
                );
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
        route: route.route,
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
