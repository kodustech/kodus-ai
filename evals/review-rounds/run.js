// review-rounds — across review rounds and sandbox failures, does what reaches
// the PR match what a correct review delivers? Issues #2039, #2040, #2020.
//
//   node evals/review-rounds/run.js --model=deepseek-v4-flash@fireworks --byok-reasoning=none --reps=5
//   node evals/review-rounds/run.js --model=gpt-5.4 --case=R2 --reps=1
//   node evals/review-rounds/run.js --model=eval-fake          # wiring smoke
//   node evals/review-rounds/run.js --model=deepseek-v4-flash@fireworks --set=nightly --reps=2 \
//       --byok-reasoning=none --judge=gemini-3-flash-preview --concurrency=6 --output=<file> --gate
//
// --set=<name> runs targets.json `sets.<name>` (--case narrows it further,
// --limit=<n> keeps its first n);
// --judge pins the judge a floor was calibrated with; --concurrency runs that
// many reviews at once. --output also carries the shared result
// (evals/shared/eval-result.js): one case per review-rounds case, its claims
// handled right out of all its claims × reps; --gate compares that ratio with
// the model's floor in targets.json.
//
// Runs the review production runs (evals/shared/review-stage.js): the case's
// repository before and after the PR (evals/review-rounds/pr-of-case.js), the
// changed files as FetchChangedFilesStage renders them, the PR's earlier
// decisions as LoadExternalContextStage loads them from its decision store,
// then AgentReviewStage — both agents (the finder with its verifier and
// evidence gate, the Kody Rules agent), the anchoring, the repeat drop, dedup,
// severity and the formatter — and scores what it hands to posting. The tools
// are production's sandbox over a checkout of the case's repository; a case
// whose sandbox dies (`dead`, `dies-in-verify`, …) has those tools throw what
// the E2B SDK throws once the sandbox is gone, around production's own.
//
// Each delivered finding is matched to the case's claims by the recall judge
// (evals/investigation/recall-judge.js; JUDGE_MODEL, default gpt-5.6-luna low,
// the judge the nightly runs). Exit: 0 report / 1 --gate failed / 2 infra.

if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
for (const p of [
    path.join(__dirname, '../../.env'),
    path.join(__dirname, '../../../../.env'),
]) {
    if (fs.existsSync(p)) {
        require('dotenv').config({ path: p, quiet: true });
        break;
    }
}
// --judge, read before the judge module reads JUDGE_MODEL. The pinned judge
// takes its own provider's key: JUDGE_API_KEY, which wins over any other
// (recall-judge.js loadKeyForModel), is the key of the job's default judge.
const judgeArg = process.argv.find((a) => a.startsWith('--judge='));
if (judgeArg) {
    process.env.JUDGE_MODEL = judgeArg.slice('--judge='.length);
    delete process.env.JUDGE_API_KEY;
}
if (!process.env.JUDGE_MODEL) {
    process.env.JUDGE_MODEL = 'gpt-5.6-luna';
    process.env.JUDGE_REASONING_EFFORT =
        process.env.JUDGE_REASONING_EFFORT || 'low';
}
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

// Private customer exports can be replayed locally without vendoring their code.
const casesFile = process.argv
    .find((a) => a.startsWith('--cases-file='))
    ?.slice('--cases-file='.length);
let cases;
let casesSourceDigest;
try {
    if (casesFile) {
        const source = fs.readFileSync(path.resolve(casesFile), 'utf8');
        cases = JSON.parse(source).cases;
        casesSourceDigest = crypto
            .createHash('sha256')
            .update(source)
            .digest('hex');
    } else {
        cases = require('./cases').cases;
    }
    if (!Array.isArray(cases))
        throw new Error('Expected a JSON object with a cases array');
} catch (error) {
    console.error(`INFRA: cannot load review cases: ${error.message}`);
    process.exit(2);
}
const { selectCases } = require('./case-selection');
const { assertCompleteRuleReview } = require('./measurement');
const { evalQuestion } = require('../shared/eval-result');
const { countTokens, tokensUsed } = require('../shared/eval-kit');
const {
    matchComment,
    loadJudgeKey,
    JUDGE_MODEL,
} = require('../investigation/recall-judge');

const arg = (n, d) => {
    const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
    return hit ? hit.slice(n.length + 3) : d;
};
const MODEL = arg('model');
const REPS = Number(arg('reps', 1));
const ONLY = arg('case');
// --byok-reasoning=<none|low|medium|high>: route both agents through a BYOK
// slot — the path production customers take, each with the reasoning effort
// they configured — instead of the env/managed default (family effort).
const BYOK_REASONING = arg('byok-reasoning');
const GATE = process.argv.includes('--gate');
const SET = arg('set');
const LIMIT = Number(arg('limit', 0)) || 0;
const CONCURRENCY = Math.max(1, Number(arg('concurrency', 1)) || 1);
const TARGETS = require('./targets.json');
const STARTED_AT = new Date().toISOString();
const OUT = arg(
    'output',
    path.join(
        __dirname,
        'results',
        `${String(MODEL).replace(/[^\w.-]/g, '_')}-${Date.now()}.json`,
    ),
);
if (!MODEL && require.main === module) {
    console.error('usage: --model=<tier0 id>');
    process.exit(2);
}

// Bind live evidence to the uncommitted engine too; HEAD alone misses this work.
function engineSnapshot() {
    const root = path.join(__dirname, '../..');
    const git = (...args) =>
        // A large uncommitted diff overflows the default 1 MB buffer.
        execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    const hash = crypto.createHash('sha256');
    hash.update(git('diff', 'HEAD', '--', 'libs', 'evals'));
    const extra = git(
        'ls-files',
        '--others',
        '--exclude-standard',
        '--',
        'libs',
        'evals',
    )
        .split('\n')
        .filter((p) => p && !p.includes('/results/') && !p.includes('/.cache'))
        .sort();
    for (const p of extra) {
        hash.update(p);
        hash.update(fs.readFileSync(path.join(root, p)));
    }
    return {
        commit: git('rev-parse', 'HEAD').trim(),
        sourceDigest: hash.digest('hex'),
    };
}

// ---------------------------------------------------------------- sandbox
class SandboxNotFoundError extends Error {}
// Per review: whether the verifier has started (dies-in-verify) and what it
// decided. Reviews run concurrently (--concurrency), so each gets its own.
const { AsyncLocalStorage } = require('async_hooks');
const reviewPhase = new AsyncLocalStorage();
const fallbackPhase = { verify: false, verdicts: [] };
const currentPhase = () => reviewPhase.getStore() || fallbackPhase;

// A sandbox that dies, around production's own (the checkout LocalSandboxService
// makes at the PR's head): its tools answer as production's until the case's
// mode says the sandbox is gone, then throw what the E2B SDK throws once it is.
// Modes (README → What it drives): alive | dead | dies-in-verify |
// dies-after-reading:<path> | dead-for:<path> | flaky:<K>. `none` (no sandbox
// at all, the self-contained review) never reaches here.
function dyingSandbox(mode, counter) {
    const norm = (p) =>
        String(p || '.')
            .replace(/^\.?\/+/, '')
            .replace(/\/+$/, '');
    const [kind, arg] = String(mode).split(/:(.*)/s);
    const state = { premiseRead: false };
    const dead = (target) => {
        if (kind === 'dead') return true;
        if (kind === 'dies-in-verify') return currentPhase().verify;
        if (kind === 'dies-after-reading') return state.premiseRead;
        if (kind === 'dead-for') return !!target && norm(target) === norm(arg);
        if (kind === 'flaky') return counter.calls <= Number(arg);
        return false;
    };
    const guard = (target) => {
        counter.calls++;
        if (dead(target)) {
            counter.failed++;
            throw new SandboxNotFoundError(
                'Sandbox is probably not running anymore',
            );
        }
    };
    // dead-for: the file's content is unreachable, whichever tool asks for it.
    const mentions = (command) =>
        kind === 'dead-for' && String(command || '').includes(norm(arg))
            ? arg
            : undefined;
    const withoutUnreachable = (out) =>
        kind !== 'dead-for'
            ? out
            : String(out || '')
                  .split('\n')
                  .filter((line) => norm(line.split(':')[0]) !== norm(arg))
                  .join('\n');
    return (handle) => {
        const rc = handle.remoteCommands;
        const remoteCommands = {
            ...rc,
            read: async (p, ...rest) => {
                guard(p);
                const out = await rc.read(p, ...rest);
                if (kind === 'dies-after-reading' && norm(p) === norm(arg))
                    state.premiseRead = true;
                return out;
            },
            grep: async (...a) => {
                guard();
                return withoutUnreachable(await rc.grep(...a));
            },
            listDir: async (...a) => {
                guard();
                return rc.listDir(...a);
            },
            exec: async (command, ...rest) => {
                guard(mentions(command));
                return rc.exec(command, ...rest);
            },
        };
        // A sandbox gone before the review fails the stage's own commands too
        // (the call-graph build); one that dies later ran them while alive.
        const run =
            kind === 'dead'
                ? async () => {
                      throw new SandboxNotFoundError(
                          'Sandbox is probably not running anymore',
                      );
                  }
                : handle.run;
        return { ...handle, remoteCommands, run };
    };
}

// `dies-in-verify`: flip the sandbox dead when the first verifier run starts.
// Instrumentation around the real LlmVerifier, not a stand-in for it.
function instrumentVerifier() {
    const {
        LlmVerifier,
    } = require('../../libs/code-review/infrastructure/agents/core/verifier.agent.ts');
    const original = LlmVerifier.prototype.verify;
    LlmVerifier.prototype.verify = async function (...args) {
        const phase = currentPhase();
        phase.verify = true;
        const verdict = await original.apply(this, args);
        (phase.verdicts ||= []).push({
            file: args[0].relevantFile,
            claim: args[0].suggestionContent,
            keep: verdict.keep,
            rationale: verdict.rationale,
            dimensions: verdict.dimensions,
            tools: (verdict.toolCalls || []).map((tc) => ({
                name: tc.name,
                args: tc.args,
                failed: /^Error|^ERROR:/.test(tc.result || ''),
            })),
        });
        return verdict;
    };
}

// The repeat check's own verdict, read where the stage calls it: a check whose
// model call failed posts what it had to judge (fail-open), which is not a
// measurement of the repeat drop.
let repeatChecks;
function observeRepeatCheck() {
    if (repeatChecks) return;
    repeatChecks = new AsyncLocalStorage();
    const mod = require('../../libs/code-review/infrastructure/agents/engine/repeat-check.ts');
    const real = mod.checkRepeats;
    mod.checkRepeats = async (...a) => {
        const out = await real(...a);
        repeatChecks.getStore()?.push(out);
        return out;
    };
}

const INDEX_REF =
    /\b(previous|prior|earlier)?\s*(decision|entry|suggestion)\s*(#|index\s*)\d+|PreviousDecision\s+index/i;
const REFERS_PRIOR =
    /(previous|earlier|prior|last)\s+(review|round|suggestion|comment|recommendation)|kody('s)?\s+(earlier|previous|own)|suggested (earlier|previously|before)|revis(es|ing) (the|an|our) (earlier|previous)/i;
// Placeholder until the design fixes how an unverified finding is carried:
// any of these on the delivered finding counts as "marked".
const isMarkedUnverified = (f) =>
    f?.unverified === true ||
    f?.evidence?.status === 'unverified' ||
    f?.verification === 'unverified';

// The org's model: the managed route, or with --byok-reasoning a stored BYOK
// config carrying that effort, routed by production (evals/shared/model-route.js).
let routeCache;
function orgRoute() {
    if (routeCache) return routeCache;
    const { resolveRoute, evalPermissionService } = require('../shared/model-route');
    const saved = process.env.RECALL_REASONING_EFFORT;
    if (BYOK_REASONING) process.env.RECALL_REASONING_EFFORT = BYOK_REASONING;
    else delete process.env.RECALL_REASONING_EFFORT;
    try {
        const route = resolveRoute({ provider: 'tier0', model: MODEL });
        routeCache = { route, permissionService: evalPermissionService(route.storedConfig) };
    } finally {
        if (saved === undefined) delete process.env.RECALL_REASONING_EFFORT;
        else process.env.RECALL_REASONING_EFFORT = saved;
    }
    return routeCache;
}

// A loop that produced nothing ran nothing (agent-provider.js agentRunFailure).
const loopRan = (result) =>
    !!result && (Number(result.steps) > 0 || Number(result.usage?.outputTokens) > 0);

async function once(c, judgeKey) {
    const { reviewPullRequest } = require('../shared/review-stage');
    const { prOf, teamOf, decisionsOf } = require('./pr-of-case');
    observeRepeatCheck();

    const phase = currentPhase();
    phase.verify = false;
    phase.verdicts = [];
    const counter = { calls: 0, failed: 0 };
    const t0 = Date.now();
    const { route, permissionService } = orgRoute();
    const checks = [];
    // The PR through production's review (evals/shared/review-stage.js):
    // the changed files, the earlier decisions loaded from the PR's decision
    // store, both agents, the anchoring, the repeat drop, dedup, severity, the
    // formatter, and what the stage hands to posting.
    const review = await repeatChecks.run(checks, () =>
        reviewPullRequest({
            pr: prOf(c),
            team: teamOf(c),
            route,
            permissionService,
            decisions: decisionsOf(c),
            sandbox: c.sandbox === 'none' ? 'none' : 'alive',
            // `alive` only counts the calls: every command reaches the sandbox.
            wrapSandbox:
                c.sandbox === 'none'
                    ? undefined
                    : dyingSandbox(c.sandbox || 'alive', counter),
        }),
    );
    if (review.skipped) {
        throw new Error(`INFRA: production skipped the review: ${review.skipped}`);
    }
    // A provider failure degrades to "no findings" inside the engine — not a measurement.
    if (!review.loops.length || !review.loops.some((l) => loopRan(l.result))) {
        const r = review.loops[0]?.result;
        throw new Error(
            `INFRA: the finder did not run (finishReason=${r?.finishReason}, steps=${r?.steps ?? 0})`,
        );
    }
    if ((c.kodyRules || []).length) {
        if (!review.ruleReviews.length) {
            throw new Error('INFRA: the Kody Rules agent did not run');
        }
        for (const out of review.ruleReviews) assertCompleteRuleReview(out.warnings);
    }
    if (checks.some((r) => r.model === 'failed')) {
        throw new Error('INFRA: the repeat check call failed');
    }

    // What reaches the PR: each comment the stage hands to posting, at its
    // place and at every place listed under "Also found in" (same text: it can
    // answer a claim there, and a repeat listed there is a repeat posted).
    const delivered = review.shipped.flatMap((s, i) => {
        const others = [...new Set([...(s.alsoFoundIn || []), ...(s.kodyRuleOtherLocations || [])])];
        const base = {
            sourceIndex: i,
            severity: s.severity,
            text: s.suggestionContent,
            linkedById: !!s.revisesSuggestionId,
            revisesSuggestionId: s.revisesSuggestionId,
            label: s.label,
            brokenKodyRulesIds: s.brokenKodyRulesIds,
            existingCode: s.existingCode,
            lineEnd: s.relevantLinesEnd,
            marked: isMarkedUnverified(s),
        };
        return [
            { ...base, file: s.relevantFile, line: s.relevantLinesStart },
            ...others.map((loc) => {
                const at = loc.lastIndexOf(':');
                return {
                    ...base,
                    file: loc.slice(0, at),
                    line: Number(loc.slice(at + 1).split('-')[0]) || null,
                    alsoFoundIn: true,
                };
            }),
        ];
    });

    const claims = [];
    // A delivered comment answers one claim at most: two claims on the same
    // rule read alike, and one comment must not count as both.
    const taken = new Set();
    for (const claim of c.claims) {
        let match = null;
        for (const d of delivered) {
            if (taken.has(d)) continue;
            // `at` pins a claim to a region when two claims read alike. The
            // two lines of slack around it never reach into another claim's
            // region: a comment on the next function answers that one.
            const inside = (cl) =>
                cl.at &&
                d.file === cl.at.file &&
                d.line >= cl.at.lines[0] &&
                d.line <= cl.at.lines[1];
            if (
                claim.at &&
                (d.file !== claim.at.file ||
                    !(
                        d.line >= claim.at.lines[0] - 2 &&
                        d.line <= claim.at.lines[1] + 2
                    ) ||
                    (!inside(claim) &&
                        c.claims.some((other) => other !== claim && inside(other))))
            )
                continue;
            if (await matchComment(judgeKey, claim.golden, d.text)) {
                taken.add(d);
                match = d;
                break;
            }
        }
        const linked =
            !!match && match.linkedById && REFERS_PRIOR.test(match.text);
        const pass = {
            deliver: !!match,
            not_deliver: !match,
            deliver_linked: !!match && linked,
            if_delivered_linked: !match || linked,
            not_deliver_normal: !match || match.marked,
            observe: true,
        }[claim.expect];
        claims.push({
            id: claim.id,
            expect: claim.expect,
            proposed: !!claim.proposed,
            truth: claim.truth,
            delivered: !!match,
            linked,
            linkedById: !!match?.linkedById,
            marked: !!match?.marked,
            severity: match?.severity ?? null,
            pass,
        });
    }
    const { PriorityStatus } = require('../../libs/platformData/domain/pullRequests/enums/priorityStatus.enum.ts');
    const repeats = review.discarded.filter((s) => s.priorityStatus === PriorityStatus.DISCARDED_BY_REPEAT);
    const loop = review.loops[0]?.result;
    return {
        case: c.id,
        family: c.family,
        sandbox: c.sandbox,
        ms: Date.now() - t0,
        // #2039: a delivered finding pointed at an earlier one by its prompt index
        // ("previous decision #3"), which means nothing to the reader.
        indexRefs: delivered.filter(
            (d) => !d.alsoFoundIn && INDEX_REF.test(d.text),
        ).length,
        verificationEvidence: phase.verdicts,
        // What the repeat drop kept off the PR.
        alreadyPosted: repeats.map((r) => ({
            file: r.relevantFile,
            line: r.relevantLinesStart,
            label: r.label,
            revisesSuggestionId: r.revisesSuggestionId ?? null,
        })),
        repeatCheck: { model: checks.map((r) => r.model).join(',') || null },
        discarded: review.discarded.length,
        sandboxCalls: counter.calls,
        sandboxFailed: counter.failed,
        anomalies: loop?.anomalies,
        warnings: (loop?.warnings || []).length,
        verification: loop?.verification && {
            before: loop.verification.beforeCount,
            after: loop.verification.afterCount,
        },
        delivered,
        // What posting saves, for a later round's decision store (lifecycle.js).
        posted: {
            onFiles: review.shippedOnFiles.map(postedFields),
            onPR: review.shippedOnPR.map(postedFields),
        },
        claims,
    };
}

// The fields of a posted suggestion its decision record is read from
// (pr-decision-store.service.ts toRecord / toRecordFromPrLevel).
const postedFields = (s) => ({
    relevantFile: s.relevantFile,
    relevantLinesStart: s.relevantLinesStart,
    relevantLinesEnd: s.relevantLinesEnd,
    suggestionContent: s.suggestionContent,
    fullExplanation: s.fullExplanation,
    label: s.label,
    brokenKodyRulesIds: s.brokenKodyRulesIds,
    existingCode: s.existingCode,
});

// ---------------------------------------------------------------- scoring
// One rate per problem, over every (rep × claim) with that expectation.
const PROBLEMS = {
    // shipped as a regular finding although it rests on code nobody could read
    'unverified-shipped (#2040)': {
        pick: (cl) => cl.expect === 'not_deliver_normal',
        violated: (cl) => !cl.pass,
    },
    // a problem an earlier suggestion already raised, posted again — open,
    // declined, or "fixed" in a way the reviewer finds incomplete
    'repeat-of-sent': {
        pick: (cl) => cl.expect === 'not_deliver' && /repeat/.test(cl.id),
        violated: (cl) => !cl.pass,
    },
    // a revision of an earlier Kody suggestion reached the PR without saying so
    'revision-unlinked (#2039/#2020)': {
        pick: (cl) => /linked/.test(cl.expect) && cl.delivered,
        violated: (cl) => !cl.linked,
    },
    // control: a claim the readable code refutes reached the PR
    'refuted-shipped (control)': {
        pick: (cl) => cl.expect === 'not_deliver' && !/repeat/.test(cl.id),
        violated: (cl) => !cl.pass,
    },
    // guard: a true problem that must reach the PR did not. On the unfixed
    // engine this is plain finder recall; a fix must not move it up.
    'true-bug-missed (guard)': {
        pick: (cl) =>
            cl.truth === 'true' &&
            (cl.expect === 'deliver' || cl.expect === 'deliver_linked'),
        violated: (cl) => !cl.delivered,
    },
};

function summarize(rows) {
    const ok = rows.filter((r) => !r.error);
    const all = ok.flatMap((r) =>
        r.claims.map((cl) => ({ ...cl, case: r.case })),
    );
    const problems = {};
    for (const [name, { pick, violated }] of Object.entries(PROBLEMS)) {
        const s = all.filter(pick);
        const v = s.filter(violated).length;
        problems[name] = {
            n: s.length,
            violations: v,
            rate: s.length ? +(v / s.length).toFixed(3) : null,
        };
    }
    // Per delivered comment, not per claim: any finding that cites an earlier
    // one by its prompt index.
    const delivered = ok.reduce((n, r) => n + (r.delivered?.length ?? 0), 0);
    const indexRefs = ok.reduce((n, r) => n + (r.indexRefs ?? 0), 0);
    problems['index-reference (#2039)'] = {
        n: delivered,
        violations: indexRefs,
        rate: delivered ? +(indexRefs / delivered).toFixed(3) : null,
    };
    const byCase = {};
    for (const cl of all) {
        const k = `${cl.case} · ${cl.id} [${cl.expect}${cl.proposed ? ', proposed' : ''}]`;
        byCase[k] ||= { pass: 0, n: 0, delivered: 0 };
        byCase[k].n++;
        if (cl.pass) byCase[k].pass++;
        if (cl.delivered) byCase[k].delivered++;
    }
    return {
        measured: ok.length,
        infra: rows.length - ok.length,
        problems,
        byCase,
    };
}

async function main() {
    // --rescore=<run.json>: re-apply the CURRENT expectations in cases.js to a
    // saved run (what was delivered, linked, marked) — no model, no judge. Used
    // when a design decision flips a `proposed` expectation.
    const RESCORE = arg('rescore');
    if (RESCORE) {
        const saved = JSON.parse(fs.readFileSync(RESCORE, 'utf8'));
        const byId = Object.fromEntries(cases.map((c) => [c.id, c]));
        for (const row of saved.rows.filter((r) => !r.error)) {
            for (const cl of row.claims) {
                const spec = byId[row.case]?.claims.find((x) => x.id === cl.id);
                if (!spec) continue;
                Object.assign(cl, {
                    expect: spec.expect,
                    proposed: !!spec.proposed,
                    truth: spec.truth,
                });
                cl.pass = {
                    deliver: cl.delivered,
                    not_deliver: !cl.delivered,
                    deliver_linked: cl.delivered && cl.linked,
                    if_delivered_linked: !cl.delivered || cl.linked,
                    not_deliver_normal: !cl.delivered || cl.marked,
                    observe: true,
                }[cl.expect];
            }
        }
        const summary = summarize(saved.rows);
        fs.writeFileSync(
            RESCORE,
            JSON.stringify({ ...saved, summary }, null, 2),
        );
        console.log(JSON.stringify(summary.problems, null, 2));
        process.exit(0);
    }
    const judgeKey = loadJudgeKey();
    // The org's route, resolved before any case: an unknown model or a missing
    // key stops the run here. It leaves API_OPEN_AI_API_KEY the platform's key,
    // which the dedup's embedder reads.
    try {
        orgRoute();
    } catch (e) {
        console.error(`INFRA: ${e.message}`);
        process.exit(2);
    }
    if (!judgeKey) {
        console.error(`INFRA: no key for judge ${JUDGE_MODEL}`);
        process.exit(2);
    }
    instrumentVerifier();
    countTokens();
    const rows = [];
    let selected;
    let narrowed = false;
    try {
        selected = selectCases(setCases(SET), ONLY);
        narrowed = LIMIT > 0 && LIMIT < selected.length;
        if (narrowed) selected = selected.slice(0, LIMIT);
    } catch (e) {
        console.error(`INFRA: ${e.message}`);
        process.exit(2);
    }
    const engine = engineSnapshot();
    const checkpoint = (complete) => {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(
            OUT,
            JSON.stringify(
                {
                    model: MODEL,
                    byokReasoning: BYOK_REASONING || null,
                    judge: JUDGE_MODEL,
                    judgeReasoningEffort:
                        process.env.JUDGE_REASONING_EFFORT || null,
                    reps: REPS,
                    engine,
                    startedAt: STARTED_AT,
                    updatedAt: new Date().toISOString(),
                    complete,
                    selectedCases: selected.map((c) => c.id),
                    casesSourceDigest,
                    summary: summarize(rows),
                    ...sharedResult(rows, selected),
                    rows,
                },
                null,
                2,
            ),
        );
    };
    checkpoint(false);
    const jobs = selected.flatMap((c) =>
        Array.from({ length: REPS }, (_, r) => ({ c, rep: r + 1 })),
    );
    const worker = async () => {
        for (let job = jobs.shift(); job; job = jobs.shift()) {
            const { c, rep } = job;
            try {
                const row = await reviewPhase.run(
                    { verify: false, verdicts: [] },
                    () => once(c, judgeKey),
                );
                rows.push({ model: MODEL, rep, ...row });
                console.log(
                    `[${MODEL}] ${c.id} #${rep} sandbox=${row.sandboxCalls}/${row.sandboxFailed} delivered=${row.delivered.length} :: ${row.claims.map((cl) => `${cl.id}:${cl.pass ? 'PASS' : 'FAIL'}(delivered=${cl.delivered}${cl.expect === 'deliver_linked' ? ` linked=${cl.linked}` : ''})`).join(' ')}`,
                );
            } catch (e) {
                rows.push({ model: MODEL, rep, case: c.id, error: e.message });
                console.log(`[${MODEL}] ${c.id} #${rep}: ${e.message}`);
            }
            checkpoint(false);
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    const summary = summarize(rows);
    checkpoint(true);
    console.log('\n' + JSON.stringify(summary.problems, null, 2));
    console.log(`wrote ${OUT}`);
    // More than 5% of runs unmeasured is "not measured" (evals/README.md).
    if (!summary.measured || summary.infra / rows.length > 0.05) {
        console.error(
            `INFRA: ${summary.infra}/${rows.length} runs not measured`,
        );
        process.exit(2);
    }
    if (GATE) {
        const target = TARGETS.models?.[MODEL];
        const { metric } = sharedResult(rows, selected);
        // A floor holds only for the set, the judge and the reasoning effort it
        // was calibrated with (evals/README.md).
        const mismatch = !target?.floor
            ? `no floor for ${MODEL} in evals/review-rounds/targets.json`
            : narrowed
              ? `--limit=${LIMIT} measures part of the set the floor was calibrated on`
              : target.set !== SET
              ? `the floor is for --set=${target.set}, this run used ${SET || 'every case'}`
              : target.judge !== JUDGE_MODEL
                ? `the floor was calibrated with judge ${target.judge}, this run used ${JUDGE_MODEL}`
                : (target.byokReasoning ?? null) !== (BYOK_REASONING ?? null)
                  ? `the floor is for --byok-reasoning=${target.byokReasoning}, this run used ${BYOK_REASONING}`
                  : null;
        if (mismatch) {
            console.error(`\n⚠️ GATE NOT EVALUATED: ${mismatch}`);
            process.exit(2);
        }
        if (metric.value < target.floor) {
            console.error(
                `\n❌ GATE FAILED: ${(metric.value * 100).toFixed(1)}% of claims handled right < floor ${(target.floor * 100).toFixed(1)}%`,
            );
            process.exit(1);
        }
    }
    process.exit(0);
}

// The cases of --set (targets.json `sets`), or every case.
function setCases(name) {
    if (!name) return cases;
    const ids = TARGETS.sets?.[name];
    if (!ids) throw new Error(`unknown --set=${name} (targets.json sets)`);
    // A set measures the cases themselves, in its own order (--limit takes
    // the first ones); their -control twins were shown to post on the full
    // runs (results/).
    const picked = selectCases(cases, ids.join(',')).filter(
        (c) => c.family !== 'control',
    );
    const at = (c) => ids.findIndex((id) => c.id === id || c.id.startsWith(`${id}-`));
    return picked.sort((a, b) => at(a) - at(b));
}

// What a case checks, in one sentence: the shape for a production one,
// otherwise what each claim must do.
const EXPECT_WORDS = {
    deliver: 'posted',
    not_deliver: 'not posted',
    deliver_linked: 'posted and linked',
    if_delivered_linked: 'linked if posted',
    not_deliver_normal: 'marked if posted',
    observe: 'observed',
};
const caseChecks = (c) =>
    c.shape ||
    c.claims
        .map((cl) => `${cl.id}: ${EXPECT_WORDS[cl.expect] || cl.expect}`)
        .join('; ');

// The shared result (evals/shared/eval-result.js): per case, its claims
// handled right out of all its claims over the measured reps.
function sharedResult(rows, selected) {
    const measured = rows.filter((r) => !r.error);
    const perCase = selected
        .map((c) => {
            const claims = measured
                .filter((r) => r.case === c.id)
                .flatMap((r) => r.claims);
            return {
                id: c.id,
                checks: caseChecks(c),
                hits: claims.filter((cl) => cl.pass).length,
                total: claims.length,
                detail: claims.map((cl) => ({ what: cl.id, ok: !!cl.pass })),
            };
        })
        .filter((c) => c.total > 0);
    const hits = perCase.reduce((n, c) => n + c.hits, 0);
    const total = perCase.reduce((n, c) => n + c.total, 0);
    const target = TARGETS.models?.[MODEL] || {};
    return {
        eval: 'review-rounds',
        question: evalQuestion('evals/review-rounds'),
        metric: {
            name: 'of claims handled right',
            value: total ? hits / total : null,
            floor: target.floor ?? null,
            baseline: target.observed ?? null,
        },
        runs: REPS,
        tokens: tokensUsed(),
        infra: { errored: rows.length - measured.length, total: rows.length },
        cases: perCase,
    };
}

module.exports = { once, instrumentVerifier, engineSnapshot, orgRoute };
if (require.main === module)
    main().catch((error) => {
        console.error(`INFRA: ${error.stack || error}`);
        process.exit(2);
    });
