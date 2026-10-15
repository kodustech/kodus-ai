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
// --judge, read before the judge module reads JUDGE_MODEL.
const judgeArg = process.argv.find((a) => a.startsWith('--judge='));
if (judgeArg) process.env.JUDGE_MODEL = judgeArg.slice('--judge='.length);
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
const { applyModelEnv } = require('../shared/tier0-models');
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
// Per review: whether the verifier has started (dies-in-verify) and what it
// decided. Reviews run concurrently (--concurrency), so each gets its own.
const { AsyncLocalStorage } = require('async_hooks');
const reviewPhase = new AsyncLocalStorage();
const fallbackPhase = { verify: false, verdicts: [] };
const currentPhase = () => reviewPhase.getStore() || fallbackPhase;

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
        // Production always passes the PR's commits (review-orchestrator).
        commits: c.commits,
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

// What base-code-review-agent.provider.ts hands the finder from the routed
// slot (model-factory.ts): its reasoning effort and, on OpenRouter, the pinned
// upstream. Without them the finder ran on the model's default reasoning,
// whatever --byok-reasoning said.
function finderModelParams() {
    const s = byokSlot();
    if (!s) return {};
    const { getModelName } = require('../../libs/llm/byok-to-vercel.ts');
    return {
        reasoningEffort: s.reasoningEffort,
        byokProvider: s.provider,
        modelName: getModelName(s),
        openrouterProviderOrder: s.openrouterProviderOrder,
        openrouterAllowFallbacks: s.openrouterAllowFallbacks,
    };
}

// The generalist finder + verifier, as the agent-review stage runs it.
async function runFinder(c, counter, runAgentLoopViaCore, buildEvalModel) {
    const { input, systemPrompt, userPrompt } = buildPrompts(c);
    const out = await runAgentLoopViaCore(
        {
            ...finderModelParams(),
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
            byokConfig: byokSlot() ?? undefined,
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

let slot;
function byokSlot() {
    if (!BYOK_REASONING) return null;
    if (slot) return slot;
    const { TIER0 } = require('../shared/tier0-models');
    const spec = TIER0[MODEL];
    const key = spec?.keyEnvs.map((n) => process.env[n]).find(Boolean);
    if (!key) throw new Error(`INFRA: --byok-reasoning needs a key for ${MODEL}`);
    const { encrypt } = require('../../libs/common/utils/crypto.ts');
    // A stored BYOK model: the key encrypted as the config keeps it.
    slot = {
        // A pinned OpenRouter route is a customer's OpenRouter slot.
        provider: spec.openrouterProviderOrder ? 'open_router' : spec.provider,
        apiKey: encrypt(key),
        model: spec.doModel || MODEL,
        baseURL: spec.baseURL,
        reasoningEffort: BYOK_REASONING,
        // An OpenRouter route stays on its pinned upstream.
        ...(spec.openrouterProviderOrder
            ? {
                  openrouterProviderOrder: spec.openrouterProviderOrder,
                  openrouterAllowFallbacks: false,
              }
            : {}),
    };
    return slot;
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
        { resolveTaskSlot: async () => byokSlot(), getBYOKConfig: async () => null },
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
        commits: c.commits,
        kodyRules: c.kodyRules.map((r) => ({
            ...r,
            type: 'standard',
            status: 'active',
            scope: r.scope || 'file',
        })),
    });
    assertCompleteRuleReview(out.warnings);
    return {
        steps: out.turnsUsed ?? 0,
        finishReason: out.finishReason,
        suggestions: out.suggestions || [],
        out,
    };
}

async function once(c, judgeKey) {
    // The history reaches the agents the way production builds it: most
    // recent first, capped at MAX_PR_DECISIONS (capDecisions). The repeat
    // check reads the whole history, as agent-review.stage does (#2097).
    let wholeHistory;
    if (c.previousDecisions?.length) {
        const {
            capDecisions,
        } = require('../../libs/code-review/application/use-cases/previousReviewDecisions/build-previous-review-decisions.use-case.ts');
        const {
            MAX_REPEAT_CHECK_DECISIONS,
        } = require('../../libs/code-review/domain/contracts/pr-decision-store.contract.ts');
        wholeHistory = capDecisions(c.previousDecisions, MAX_REPEAT_CHECK_DECISIONS);
        c = { ...c, previousDecisions: capDecisions(c.previousDecisions) };
    }
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

    const phase = currentPhase();
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
    // Same step as agent-review.stage after dedup: what an earlier comment
    // already raised is not posted (#2097).
    const {
        checkRepeats,
    } = require('../../libs/code-review/infrastructure/agents/engine/repeat-check.ts');
    const repeatCheck = await checkRepeats(out.suggestions, wholeHistory, {
        organizationId: 'eval-org',
        byokConfig: byokSlot() ?? undefined,
        ruleTitleByUuid: new Map(
            (c.kodyRules || []).map((r) => [r.uuid, r.title]),
        ),
    });
    // A failed check posts what it had to judge (fail-open) — not a measurement.
    if (repeatCheck.model === 'failed') {
        throw new Error('INFRA: the repeat check call failed');
    }
    // Then the stage's per-rule merge (engine/kody-rules-merge.ts): the
    // occurrences of one rule that survive become one comment, the others
    // listed under "Also found in".
    const {
        mergeKodyRuleFindings,
    } = require('../../libs/code-review/infrastructure/agents/engine/kody-rules-merge.ts');
    const kept = mergeKodyRuleFindings(repeatCheck.kept);
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
    applyRevisionLinks(posted, wholeHistory);
    // A location under "Also found in" is posted too, with the same text: it
    // can answer a claim at that location, and a repeat listed there is a
    // repeat posted.
    const delivered = kept.flatMap((s, i) => {
        const others = s.kodyRuleOtherLocations || [];
        const text = others.length
            ? `${posted[i].suggestionContent}\n\n**Also found in:**\n${others.map((loc) => `- \`${loc}\``).join('\n')}`
            : posted[i].suggestionContent;
        const base = {
            sourceIndex: i,
            severity: severity.get(i) ?? s.severity,
            text,
            linkedById: !!posted[i].revisesSuggestionId,
            revisesSuggestionId: posted[i].revisesSuggestionId,
            label: s.label,
            brokenKodyRulesIds: s.brokenKodyRulesIds,
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
        indexRefs: delivered.filter(
            (d) => !d.alsoFoundIn && INDEX_REF.test(d.text),
        ).length,
        verificationEvidence: phase.verdicts,
        // What the repeat check kept off the PR, and the bugs it linked.
        alreadyPosted: repeatCheck.repeats.map((r) => ({
            file: r.finding.relevantFile,
            line: r.finding.relevantLinesStart,
            label: r.finding.label,
            earlierId: r.earlier.suggestionId,
            earlierOutcome: r.earlier.outcome,
            // The finder's own claim that it revises that comment, if any.
            revisesSuggestionId: r.finding.revisesSuggestionId ?? null,
            by: r.by,
        })),
        repeatCheck: { model: repeatCheck.model },
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
    // More than 5% of runs unmeasured is "not measured" (evals/AGENTS.md).
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
        // was calibrated with (evals/AGENTS.md).
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

module.exports = { once, instrumentVerifier, engineSnapshot };
if (require.main === module)
    main().catch((error) => {
        console.error(`INFRA: ${error.stack || error}`);
        process.exit(2);
    });
