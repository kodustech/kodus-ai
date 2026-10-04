// review-rounds — across review rounds and sandbox failures, does what reaches
// the PR match what a correct review delivers? Issues #2039, #2040, #2020.
//
//   node evals/review-rounds/run.js --model=deepseek-v4-flash --reps=3
//   node evals/review-rounds/run.js --model=gpt-5.4 --case=R2 --reps=1
//   node evals/review-rounds/run.js --model=eval-fake          # wiring smoke
//
// Drives the chain production runs after the sandbox is up:
//   runAgentLoopViaCore (finder + verifier + evidence gate)
//   → classifySeverity → formatSuggestionContent
// Tools go through the production registry; only RemoteCommands (the sandbox)
// is swapped: `alive` answers from the case repository, `dead` throws what the
// E2B SDK throws once the sandbox is gone, `dies-in-verify` is alive for the
// finder and dead from the first verifier run on.
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
const { cases } = casesFile
    ? JSON.parse(fs.readFileSync(path.resolve(casesFile), 'utf8'))
    : require('./cases');
const casesSourceDigest = casesFile
    ? crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.resolve(casesFile)))
          .digest('hex')
    : undefined;
const { selectCases } = require('./case-selection');
const { applyModelEnv } = require('../shared/tier0-models');
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
const GATE = process.argv.includes('--gate');
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
        execFileSync('git', args, { cwd: root, encoding: 'utf8' });
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
const phase = { verify: false };

function sandbox(mode, repo, counter) {
    const norm = (p) =>
        String(p || '.')
            .replace(/^\.?\/+/, '')
            .replace(/\/+$/, '');
    const files = Object.keys(repo);
    // Modes (README → What it drives): alive | dead | dies-in-verify |
    // dies-after-reading:<path> | dead-for:<path> | flaky:<K>. `none` (no
    // sandbox at all, self-contained prompts) never reaches here.
    const [kind, arg] = String(mode).split(/:(.*)/s);
    const state = { premiseRead: false };
    const dead = (target) => {
        if (kind === 'dead') return true;
        if (kind === 'dies-in-verify') return phase.verify;
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
    return {
        async read(p, start, end) {
            guard(p);
            if (kind === 'dies-after-reading' && norm(p) === norm(arg))
                state.premiseRead = true;
            const content = repo[norm(p)];
            if (content === undefined)
                throw new Error(`cat: ${p}: No such file or directory`);
            if (!start && !end) return content;
            return content
                .split('\n')
                .slice((start || 1) - 1, end || undefined)
                .join('\n');
        },
        async grep(pattern, searchPath) {
            guard();
            let re;
            try {
                re = new RegExp(pattern);
            } catch {
                re = new RegExp(
                    String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                );
            }
            const scope = norm(searchPath);
            const out = [];
            for (const f of files) {
                if (kind === 'dead-for' && norm(f) === norm(arg)) continue; // its content is unreachable
                if (
                    scope &&
                    scope !== '.' &&
                    !(f === scope || f.startsWith(`${scope}/`))
                )
                    continue;
                repo[f].split('\n').forEach((line, i) => {
                    if (re.test(line)) out.push(`${f}:${i + 1}:${line}`);
                });
            }
            return out.join('\n');
        },
        async listDir(dirPath) {
            guard();
            const scope = norm(dirPath);
            const names = new Set();
            for (const f of files) {
                if (scope && scope !== '.' && !f.startsWith(`${scope}/`))
                    continue;
                const rest =
                    scope && scope !== '.' ? f.slice(scope.length + 1) : f;
                names.add(rest.split('/')[0] + (rest.includes('/') ? '/' : ''));
            }
            return [...names].sort().join('\n');
        },
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

// ---------------------------------------------------------------- one review
function buildPrompts(c) {
    const {
        GeneralistAgentProvider,
    } = require('../../libs/code-review/infrastructure/agents/providers/generalist-agent.provider.ts');
    const provider = new GeneralistAgentProvider({}, {}, {});
    const input = {
        organizationAndTeamData: {
            organizationId: 'eval-org',
            teamId: 'eval-team',
        },
        changedFiles: c.changedFiles,
        // undefined selects the self-contained prompts (prompt-builder.ts buildSystemPrompt)
        remoteCommands: c.sandbox === 'none' ? undefined : {},
        prNumber: 1,
        repositoryFullName: 'eval/repo',
        languageResultPrompt: '',
        memoryRules: [],
        prTitle: c.prTitle || 'Review round',
        prBody: c.prBody || '',
        reviewMode: 'normal',
        maxSteps: 16,
        requestedCategories: ['bug', 'security', 'performance'],
        baseBranch: 'main',
        previousDecisions: c.previousDecisions,
    };
    return {
        input,
        systemPrompt: provider.buildSystemPrompt(input),
        userPrompt: provider.buildUserPrompt(input),
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

// The generalist finder + verifier, as the agent-review stage runs it.
async function runFinder(c, counter, runAgentLoopViaCore, buildEvalModel) {
    const { input, systemPrompt, userPrompt } = buildPrompts(c);
    const out = await runAgentLoopViaCore(
        {
            model: buildEvalModel({}),
            systemPrompt,
            userPrompt,
            changedFiles: input.changedFiles,
            prNumber: 1,
            repositoryFullName: 'eval/repo',
            baseBranch: 'main',
            reviewMode: 'normal',
            maxSteps: 16,
            previousDecisions: c.previousDecisions,
            agentName: `review-rounds:${c.id}`,
        },
        {
            remoteCommands:
                c.sandbox === 'none'
                    ? undefined
                    : sandbox(c.sandbox, c.repo, counter),
            byokConfig: undefined,
            byokErrorReporter: undefined,
        },
    );
    return {
        steps: out.usage?.outputTokens > 0 ? out.steps : 0,
        finishReason: out.finishReason,
        suggestions: out.findings?.suggestions || [],
        out,
    };
}

// The production Kody Rules agent (sharded rule judge), same entry point as
// evals/kody-rules/real-agent.js, over this case's sandbox.
async function runKodyRules(c, counter) {
    const {
        KodyRulesAgentProvider,
    } = require('../../libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider.ts');
    const {
        buildRepoLookup,
    } = require('../../libs/code-review/infrastructure/agents/collaborators/repo-lookup.ts');
    const provider = new KodyRulesAgentProvider(
        { resolveTaskSlot: async () => null, getBYOKConfig: async () => null },
        {
            runInSpan: async (_n, fn) =>
                typeof fn === 'function' ? fn() : undefined,
            runLLMInSpan: async ({ exec }) => exec([]),
            startSpan: () => ({ end() {}, update() {} }),
            recordAgentRunUsage: async () => {},
        },
    );
    const remoteCommands = sandbox(c.sandbox, c.repo, counter);
    const out = await provider.execute({
        organizationAndTeamData: {
            organizationId: 'eval-org',
            teamId: 'eval-team',
        },
        changedFiles: c.changedFiles,
        remoteCommands,
        repoLookup: buildRepoLookup({ type: 'eval-replay', remoteCommands }),
        prNumber: 1,
        repositoryId: 'eval-repo',
        repositoryFullName: 'eval/repo',
        baseBranch: 'main',
        reviewMode: 'normal',
        maxSteps: 20,
        prTitle: c.prTitle || 'Review round',
        prBody: c.prBody || '',
        previousDecisions: c.previousDecisions,
        kodyRules: c.kodyRules.map((r) => ({
            ...r,
            type: 'standard',
            status: 'active',
            scope: r.scope || 'file',
        })),
    });
    return {
        steps: out.turnsUsed ?? 0,
        finishReason: out.finishReason,
        suggestions: out.suggestions || [],
        out,
    };
}

async function once(c, judgeKey) {
    const {
        runAgentLoopViaCore,
    } = require('../../libs/code-review/infrastructure/agents/core/core-agent-loop.adapter.ts');
    const {
        classifySeverity,
    } = require('../../libs/code-review/infrastructure/agents/engine/classify-severity.ts');
    const {
        formatSuggestionContent,
    } = require('../../libs/code-review/infrastructure/agents/engine/format-suggestion-content.ts');
    const {
        applyRevisionLinks,
    } = require('../../libs/code-review/infrastructure/agents/engine/revision-link.ts');
    const { buildEvalModel } = require('../shared/build-model');

    phase.verify = false;
    phase.verdicts = [];
    const counter = { calls: 0, failed: 0 };
    const t0 = Date.now();
    const out =
        c.agent === 'kody-rules'
            ? await runKodyRules(c, counter)
            : await runFinder(c, counter, runAgentLoopViaCore, buildEvalModel);
    // A provider failure degrades to "no findings" inside the engine — not a measurement.
    if (!(out.steps > 0)) {
        throw new Error(
            `INFRA: agent did not run (finishReason=${out.finishReason}, steps=${out.steps})`,
        );
    }
    const kept = out.suggestions;
    const severity = await classifySeverity(kept);
    const formatted = await formatSuggestionContent(
        kept.map((s) => ({
            suggestionContent: s.suggestionContent,
            existingCode: s.existingCode,
            improvedCode: s.improvedCode,
            relevantFile: s.relevantFile,
            language: s.language,
        })),
    );
    // Same post-formatter step as agent-review.stage: the revision link line.
    const posted = kept.map((s, i) => ({
        revisesSuggestionId: s.revisesSuggestionId,
        suggestionContent:
            formatted.get(i)?.suggestionContent || s.suggestionContent,
    }));
    applyRevisionLinks(posted, c.previousDecisions);
    const delivered = kept.map((s, i) => ({
        sourceIndex: i,
        file: s.relevantFile,
        line: s.relevantLinesStart,
        severity: severity.get(i) ?? s.severity,
        text: posted[i].suggestionContent,
        linkedById: !!posted[i].revisesSuggestionId,
        revisesSuggestionId: posted[i].revisesSuggestionId,
        label: s.label,
        brokenKodyRulesIds: s.brokenKodyRulesIds,
        marked: isMarkedUnverified(s),
    }));

    const claims = [];
    // A delivered comment answers one claim at most: two claims on the same
    // rule read alike, and one comment must not count as both.
    const taken = new Set();
    for (const claim of c.claims) {
        let match = null;
        for (const d of delivered) {
            if (taken.has(d)) continue;
            // `at` pins a claim to a region when two claims read alike.
            if (
                claim.at &&
                (d.file !== claim.at.file ||
                    !(
                        d.line >= claim.at.lines[0] - 2 &&
                        d.line <= claim.at.lines[1] + 2
                    ))
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
    return {
        case: c.id,
        family: c.family,
        sandbox: c.sandbox,
        ms: Date.now() - t0,
        // #2039: a delivered finding pointed at an earlier one by its prompt index
        // ("previous decision #3"), which means nothing to the reader.
        indexRefs: delivered.filter((d) => INDEX_REF.test(d.text)).length,
        verificationEvidence: phase.verdicts,
        alreadyPosted: [], // No additional delivery LLM; suppression happens in existing agents.
        sandboxCalls: counter.calls,
        sandboxFailed: counter.failed,
        anomalies: out.out.anomalies,
        warnings: (out.out.warnings || []).length,
        verification: out.out.verification && {
            before: out.out.verification.beforeCount,
            after: out.out.verification.afterCount,
        },
        delivered: delivered.map(({ text, ...rest }) => ({
            ...rest,
            text,
        })),
        claims,
    };
}

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
    // Resolve the judge key BEFORE applyModelEnv: it overwrites API_OPEN_AI_API_KEY
    // with the reviewed model's key (see recall-judge.js loadJudgeKey).
    const judgeKey = loadJudgeKey();
    try {
        applyModelEnv(MODEL);
    } catch (e) {
        console.error(`INFRA: ${e.message}`);
        process.exit(2);
    }
    if (!judgeKey) {
        console.error(`INFRA: no key for judge ${JUDGE_MODEL}`);
        process.exit(2);
    }
    instrumentVerifier();
    const rows = [];
    const selected = selectCases(cases, ONLY);
    const engine = engineSnapshot();
    const checkpoint = (complete) => {
        fs.mkdirSync(path.dirname(OUT), { recursive: true });
        fs.writeFileSync(
            OUT,
            JSON.stringify(
                {
                    model: MODEL,
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
                    rows,
                },
                null,
                2,
            ),
        );
    };
    checkpoint(false);
    for (const c of selected) {
        for (let r = 0; r < REPS; r++) {
            try {
                const row = await once(c, judgeKey);
                rows.push({ model: MODEL, rep: r + 1, ...row });
                console.log(
                    `[${MODEL}] ${c.id} #${r + 1} sandbox=${row.sandboxCalls}/${row.sandboxFailed} delivered=${row.delivered.length} :: ${row.claims.map((cl) => `${cl.id}:${cl.pass ? 'PASS' : 'FAIL'}(delivered=${cl.delivered}${cl.expect === 'deliver_linked' ? ` linked=${cl.linked}` : ''})`).join(' ')}`,
                );
            } catch (e) {
                rows.push({
                    model: MODEL,
                    rep: r + 1,
                    case: c.id,
                    error: e.message,
                });
                console.log(`[${MODEL}] ${c.id} #${r + 1}: ${e.message}`);
            }
            checkpoint(false);
        }
    }
    const summary = summarize(rows);
    checkpoint(true);
    console.log('\n' + JSON.stringify(summary.problems, null, 2));
    console.log(`wrote ${OUT}`);
    // More than 5% of runs unmeasured is "not measured" (evals/AGENTS.md).
    if (!summary.measured || summary.infra / rows.length > 0.05) {
        console.error(
            `INFRA: ${summary.infra}/${rows.length} runs not measured`,
        );
        process.exit(2);
    }
    if (GATE) {
        // Floors are set after the fix lands (README.md → Gate). Until then the
        // gate only proves the eval still drives the engine end to end.
        process.exit(0);
    }
    process.exit(0);
}

module.exports = { once, instrumentVerifier, engineSnapshot };
if (require.main === module)
    main().catch((error) => {
        console.error(`INFRA: ${error.stack || error}`);
        process.exit(2);
    });
