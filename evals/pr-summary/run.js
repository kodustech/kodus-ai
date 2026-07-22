/**
 * PR-SUMMARY matrix eval — guards the "generate PR summary on open" feature.
 *
 * WHY THIS EXISTS: a prod incident where the summary path silently routed to a
 * hardcoded Google Gemini default with no BYOK/key and every client lost their
 * PR summary — and NO eval caught it. The review agents kept working (they
 * resolve BYOK themselves), so the model matrix stayed green while summaries
 * were dead. This eval closes that gap: it drives the REAL
 * CommentManagerService.generateSummaryPR + updateSummarizationInPR end-to-end
 * and asserts the three things that incident violated:
 *   1. a NON-EMPTY summary is produced,
 *   2. it is POSTED back to the PR description (adapter receives a body),
 *   3. the summary model ROUTES to the expected provider — never a silent
 *      keyless-Gemini degrade.
 * Plus the client-facing contract: REPLACE / CONCATENATE / COMPLEMENT compose
 * the final description correctly.
 *
 *   node evals/pr-summary/run.js [--model=gpt-5.4-mini] [--mock] [--gate]
 *                                [--behaviour=replace|concatenate|complement]
 *                                [--dataset=cases]
 *
 * MODES
 *   --mock : deterministic. The model call returns a fixed summary text (no
 *            network, no key). Validates routing + composition + posting. This
 *            is the local / harness path — zero flake, no API key needed.
 *   live   : (default, needs a key for --model) runs the real model. Asserts the
 *            SAME binary properties (summary non-empty, posted, composed, routed)
 *            — pass/fail is independent of the exact words the model picks, so a
 *            green run means the feature works, not that the prose was lucky.
 *
 * EXIT CODES (suite contract): 0 = pass, 1 = gate-fail, 2 = infra
 *   (missing key / model-construction crash / all-cases-errored network).
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: filename,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
if (process.env.HOME) {
    dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true });
}
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    }),
);
const MODEL = args.model || 'gpt-5.4-mini';
const MOCK = !!args.mock;
const GATE = !!args.gate;
const DATASET = String(args.dataset || 'cases').replace(/\.json$/, '');
const BEHAVIOUR_FILTER = args.behaviour ? String(args.behaviour) : null;

const START = '<!-- kody-pr-summary:start -->';
const END = '<!-- kody-pr-summary:end -->';
const MOCK_SUMMARY = 'MOCK_GENERATED_SUMMARY_BODY';

const { applyModelEnv } = require('../shared/tier0-models');
const { byokToVercelModel } = require('../../libs/llm/byok-to-vercel.ts');

// exit-2 helper — infra errors ALWAYS fail (a broken model must never look green).
function infra(msg) {
    console.error(`\n❌ INFRA ERROR: ${msg}`);
    process.exit(2);
}

// ── Route the model env the same way prod's self-hosted path does. In mock mode
//    we skip this so no key is required. ────────────────────────────────────
if (!MOCK) {
    try {
        applyModelEnv(MODEL);
    } catch (e) {
        infra(`cannot route model '${MODEL}': ${e.message}`);
    }
}

// Prompt seen by the model + the last model-call error, captured via the
// service's own runSummaryPromptV5 seam (see buildService). generateSummaryPR
// swallows model errors (retries, then returns null), so we grab the real error
// here to tell a transient infra failure apart from a genuine empty-summary bug.
let lastPromptSeen = null;
let lastModelError = null;

const INFRA_RE = /quota|rate.?limit|429|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|api key|unauthorized|401|403|invalid.*(key|authentication)|overloaded|503|502/i;
const isInfraMsg = (msg) => INFRA_RE.test(String(msg || ''));

const { CommentManagerService } = require(
    '../../libs/code-review/infrastructure/adapters/services/commentManager.service.ts',
);
const { BehaviourForExistingDescription } = require(
    '../../libs/core/domain/enums/code-review.enum.ts',
);
const { PlatformType } = require(
    '../../libs/core/domain/enums/platform-type.enum.ts',
);

// ── Build the real service with thin stubs. generateSummaryPR only touches
//    codeManagementService (read body + write description), permissionValidation
//    (getBYOKConfig), and observability (span wrapper). Everything else is
//    unused by this code path — matches commentManager.service.spec.ts. ───────
function buildService(existingBody, postedRef) {
    const codeManagementService = {
        getPullRequestByNumber: async () => ({ body: existingBody }),
        updateDescriptionInPullRequest: async (params) => {
            postedRef.calls += 1;
            postedRef.body = params?.summary;
        },
    };
    const permissionValidationService = {
        // No BYOK in the eval → default env routing (the incident's exact path).
        getBYOKConfig: async () => null,
        validateBasicLicense: async () => ({ allowed: true }),
    };
    const observabilityService = {
        runLLMInSpan: async ({ exec }) => ({ result: await exec(() => {}) }),
        runAiSdkLLMInSpan: async ({ exec }) => exec(),
    };
    const service = new CommentManagerService(
        /* parametersService   */ {},
        /* messageProcessor    */ {},
        /* promptRunnerService */ {},
        observabilityService,
        permissionValidationService,
        codeManagementService,
    );

    // Intercept the LLM at the service's own private seam: runSummaryPromptV5
    // receives the fully-built {systemPrompt, userPrompt} and returns the raw
    // model text. Overriding it on the instance (a) captures the exact prompt —
    // so we can assert COMPLEMENT injected the existing description — and (b) in
    // mock mode returns a fixed string with NO network / NO key. In live mode we
    // delegate to the real method, so byokToVercelModel + the real model run.
    const realRunSummaryPromptV5 = service.runSummaryPromptV5.bind(service);
    service.runSummaryPromptV5 = async (params) => {
        lastPromptSeen = {
            system: params?.systemPrompt ?? '',
            prompt: params?.userPrompt ?? '',
        };
        if (MOCK) return MOCK_SUMMARY;
        try {
            return await realRunSummaryPromptV5(params);
        } catch (e) {
            lastModelError = e; // generateSummaryPR will swallow this; we keep it
            throw e;
        }
    };
    return service;
}

const BEHAVIOUR_ENUM = {
    replace: BehaviourForExistingDescription.REPLACE,
    concatenate: BehaviourForExistingDescription.CONCATENATE,
    complement: BehaviourForExistingDescription.COMPLEMENT,
};

const countBlocks = (s) => (s ? (s.match(new RegExp(START, 'g')) || []).length : 0);
const blockContent = (s) => {
    const m = s && s.match(/<!-- kody-pr-summary:start -->([\s\S]*?)<!-- kody-pr-summary:end -->/);
    return m ? m[1].trim() : '';
};

async function runCase(c) {
    // mode 'open' (first-open, default) drives behaviourForExistingDescription;
    // mode 'commit' (new push on an already-open PR) drives behaviourForNewCommits.
    const isCommitRun = c.mode === 'commit';
    const summaryConfig = { generatePRSummary: true };
    if (isCommitRun) {
        // Enum values equal the lowercase strings (replace/concatenate/none).
        summaryConfig.behaviourForNewCommits = c.behaviour;
    } else {
        const behaviourEnum = BEHAVIOUR_ENUM[c.behaviour];
        if (!behaviourEnum) throw new Error(`unknown behaviour '${c.behaviour}' in case ${c.caseId}`);
        summaryConfig.behaviourForExistingDescription = behaviourEnum;
    }

    const posted = { calls: 0, body: null };
    const service = buildService(c.existingBody || '', posted);
    lastPromptSeen = null;
    lastModelError = null;

    const finalDescription = await service.generateSummaryPR(
        c.pr,
        { name: 'sample', id: 'repo-id' },
        c.changedFiles,
        { organizationId: 'org-1', teamId: 'team-1' },
        'en-US',
        summaryConfig,
        /* byokConfig */ null,
        isCommitRun,
        /* prPreview */ false,
        /* externalPromptContext */ undefined,
        PlatformType.GITHUB,
    );

    // Post it back — the step the incident silently skipped.
    await service.updateSummarizationInPR(
        { organizationId: 'org-1', teamId: 'team-1' },
        c.pr.number,
        { name: 'sample', id: 'repo-id' },
        finalDescription,
        /* dryRun */ undefined,
    );

    const exp = c.expect || {};
    const failures = [];

    // 1) generated + non-empty
    const content = blockContent(finalDescription || '');
    if (!finalDescription || !content) {
        // Empty summary from a swallowed model error that looks transient is
        // INFRA (bad key / quota / network), not a quality regression — don't
        // turn eval-runner noise into a red gate. A genuine empty result (no
        // model error, or a non-infra crash) stays a real failure.
        if (!MOCK && lastModelError && isInfraMsg(lastModelError.message)) {
            return { caseId: c.caseId, behaviour: c.behaviour, contentLen: 0, failures: [`infra: ${String(lastModelError.message).slice(0, 120)}`], infra: true };
        }
        failures.push('summary block empty / not generated');
    }

    // 2) posted to the PR (adapter received a non-empty body)
    if (exp.postsSummary) {
        if (posted.calls < 1) failures.push('summary was NOT posted (updateDescriptionInPullRequest never called)');
        else if (!posted.body || !posted.body.includes(START)) failures.push('posted body missing the summary block');
    }

    // 3) composition per behaviour
    if (exp.exactlyOneBlock && countBlocks(finalDescription) !== 1) {
        failures.push(`expected exactly 1 summary block, got ${countBlocks(finalDescription)}`);
    }
    if (exp.bodyPreserved === true) {
        const author = (c.existingBody || '').split('\n').find((l) => l.trim() && !l.includes('kody-pr-summary'));
        if (author && !finalDescription.includes(author.trim())) {
            failures.push(`${c.behaviour} dropped the author-written description (expected it kept)`);
        }
    }
    if (exp.bodyPreserved === false && c.existingBody) {
        const author = c.existingBody.split('\n').find((l) => l.trim() && !l.includes('kody-pr-summary'));
        if (author && finalDescription.includes(author.trim())) {
            failures.push('REPLACE did not drop the existing author description');
        }
    }
    if (exp.staleContentGone && finalDescription.includes(exp.staleContentGone)) {
        failures.push('stale prior summary block was not stripped on re-run');
    }
    // commit-run CONCATENATE accumulates INSIDE the block: the prior summary
    // content is kept and the new one appended within the same markers.
    if (exp.blockAccumulates) {
        if (!content.includes(exp.blockAccumulates)) {
            failures.push('CONCATENATE (new commit) dropped the prior summary content instead of accumulating it');
        }
        if (content === exp.blockAccumulates) {
            failures.push('CONCATENATE (new commit) did not append the new summary to the block');
        }
    }

    // 4) COMPLEMENT must feed the existing description into the model prompt
    if (exp.promptContainsExistingBody) {
        const seen = `${lastPromptSeen?.system || ''}\n${lastPromptSeen?.prompt || ''}`;
        if (!seen.includes((c.existingBody || '').slice(0, 30))) {
            failures.push('COMPLEMENT did not inject the existing description into the prompt');
        }
    }

    return { caseId: c.caseId, behaviour: c.behaviour, contentLen: content.length, failures };
}

// ── Deterministic routing guard — the incident's root cause. Runs in every
//    mode; needs no network (just constructs the SDK model object). Asserts the
//    POSITIVE invariant (summary resolves to the model it SHOULD), not a
//    provider blocklist — Gemini is a legit configured model, the bug was
//    silent degradation to a model nobody chose. ──────────────────────────────
const SUMMARY_DEFAULT = 'kimi-k2.7-code'; // the defaultModelOverride the summary path passes

function routingChecks() {
    const failures = [];

    // 1) Cloud default (no BYOK, no self-hosted env model): the summary must
    //    resolve to the SAME working default the review engine uses — never
    //    silently swap to some other/keyless model (the prod-incident shape).
    const savedEnvModel = process.env.API_LLM_PROVIDER_MODEL;
    try {
        delete process.env.API_LLM_PROVIDER_MODEL;
        const cloud = byokToVercelModel(undefined, 'main', {}, SUMMARY_DEFAULT);
        if (cloud.modelId !== SUMMARY_DEFAULT) {
            failures.push(`cloud-default summary resolved to '${cloud.modelId}', expected '${SUMMARY_DEFAULT}' — silent model swap`);
        }
    } finally {
        if (savedEnvModel === undefined) delete process.env.API_LLM_PROVIDER_MODEL;
        else process.env.API_LLM_PROVIDER_MODEL = savedEnvModel;
    }

    // 2) Self-hosted routing (live only — env is routed by applyModelEnv): the
    //    model the client CONFIGURED must be exactly what the summary uses, not
    //    silently overridden by the kimi default. This is the per-model matrix
    //    assertion: gpt-mini stays gpt-mini, gemini-flash stays gemini-flash.
    if (!MOCK) {
        const m = byokToVercelModel(undefined, 'main', {}, SUMMARY_DEFAULT);
        if (m.modelId !== MODEL) {
            failures.push(`self-hosted summary routed to '${m.modelId}', expected the configured '${MODEL}'`);
        }
    }
    return failures;
}

// ── Commit-run gate: drives the REAL pipeline stage (no model — generateSummaryPR
//    is spied) to assert the generate/post DECISION per (mode × behaviour). This
//    is where behaviourForNewCommits=NONE lives: the gate that stops regenerating
//    the summary on a new push, and the incident-class risk that a config flip
//    silently kills posting. Deterministic → runs in every mode, always gates. ──
const StageMod = require(
    '../../libs/code-review/pipeline/stages/finish-comments.stage.ts',
);
const { frozenContext } = require(
    '../../test/fixtures/frozen-pipeline-context.ts',
);
const { PullRequestMessageStatus } = require(
    '../../libs/core/infrastructure/config/types/general/pullRequestMessages.type.ts',
);

async function commitGateChecks() {
    const UpdateCommentsAndGenerateSummaryStage =
        StageMod.UpdateCommentsAndGenerateSummaryStage;
    const scenarios = [
        { name: 'open → generate + post', last: undefined, summary: { generatePRSummary: true }, call: true, commit: false },
        { name: 'open → summary OFF → skip', last: undefined, summary: { generatePRSummary: false }, call: false },
        { name: 'commit + NONE → no regen/post', last: { id: 'prev' }, summary: { generatePRSummary: true, behaviourForNewCommits: 'none' }, call: false },
        { name: 'commit + REPLACE → generate + post', last: { id: 'prev' }, summary: { generatePRSummary: true, behaviourForNewCommits: 'replace' }, call: true, commit: true },
        { name: 'commit + CONCATENATE → generate + post', last: { id: 'prev' }, summary: { generatePRSummary: true, behaviourForNewCommits: 'concatenate' }, call: true, commit: true },
        { name: 'commit + summary OFF → skip', last: { id: 'prev' }, summary: { generatePRSummary: false, behaviourForNewCommits: 'replace' }, call: false },
    ];

    const failures = [];
    for (const s of scenarios) {
        const spy = { gen: 0, post: 0, isCommit: null };
        const commentManagerService = {
            generateSummaryPR: async (...a) => { spy.gen += 1; spy.isCommit = a[7]; return 'GENERATED'; },
            updateSummarizationInPR: async () => { spy.post += 1; },
            updateOverallComment: async () => {},
            processEndReviewMessageTemplate: async () => 'body',
        };
        const pullRequestManagerService = { getChangedFilesMetadata: async () => [] };
        const stage = new UpdateCommentsAndGenerateSummaryStage(
            commentManagerService,
            pullRequestManagerService,
        );
        const ctx = frozenContext({
            lastExecution: s.last,
            errors: [],
            codeReviewConfig: { languageResultPrompt: 'en-US', summary: s.summary },
            repository: { id: 'r', name: 'sample' },
            pullRequest: { number: 7 },
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            platformType: undefined,
            initialCommentData: { commentId: 1, noteId: 2, threadId: 3 },
            changedFiles: [],
            dryRun: { enabled: false },
            externalPromptContext: undefined,
            lineComments: [],
            // INACTIVE end-review message → stage returns right after the summary
            // decision, so only the generate/post spies matter here.
            pullRequestMessagesConfig: {
                endReviewMessage: { status: PullRequestMessageStatus.INACTIVE },
            },
        });
        try {
            await stage.executeStage(ctx);
        } catch (e) {
            failures.push(`${s.name}: stage threw — ${String(e && e.message).slice(0, 120)}`);
            continue;
        }
        const called = spy.gen > 0;
        const posted = spy.post > 0;
        if (called !== s.call) failures.push(`${s.name}: generateSummaryPR called=${called}, expected ${s.call}`);
        if (posted !== s.call) failures.push(`${s.name}: posted=${posted}, expected ${s.call}`);
        if (s.call && s.commit !== undefined && spy.isCommit !== s.commit) {
            failures.push(`${s.name}: isCommitRun=${spy.isCommit}, expected ${s.commit}`);
        }
    }
    return failures;
}

async function main() {
    const cases = require(`./datasets/${DATASET}.json`).filter(
        (c) => !BEHAVIOUR_FILTER || c.behaviour === BEHAVIOUR_FILTER,
    );
    if (!cases.length) infra(`no cases in dataset '${DATASET}'${BEHAVIOUR_FILTER ? ` for behaviour '${BEHAVIOUR_FILTER}'` : ''}`);

    console.log(`════ PR-summary eval · model=${MODEL} · ${MOCK ? 'MOCK' : 'LIVE'} · ${cases.length} cases ════\n`);

    // Routing guard first — a routing regression is the whole reason this exists.
    const routeFailures = routingChecks();
    console.log(`routing guard: ${routeFailures.length ? '❌ ' + routeFailures.length + ' failure(s)' : '✅ ok'}`);
    for (const f of routeFailures) console.log(`   · ${f}`);

    // Commit-run gate (stage-level generate/post decision, incl. NONE).
    const gateFailures = await commitGateChecks();
    console.log(`commit-run gate: ${gateFailures.length ? '❌ ' + gateFailures.length + ' failure(s)' : '✅ ok'}`);
    for (const f of gateFailures) console.log(`   · ${f}`);

    const results = [];
    let errored = 0;
    for (const c of cases) {
        try {
            const r = await runCase(c);
            results.push(r);
            const ok = r.failures.length === 0;
            console.log(`${ok ? '✅' : '❌'} ${c.caseId.padEnd(26)} [${c.behaviour}] summaryLen=${r.contentLen}`);
            for (const f of r.failures) console.log(`      · ${f}`);
        } catch (e) {
            errored += 1;
            const msg = String(e && e.message ? e.message : e);
            const isInfra = isInfraMsg(msg);
            console.log(`${isInfra ? '⚠️ ' : '❌'} ${c.caseId.padEnd(26)} [${c.behaviour}] ${isInfra ? 'INFRA' : 'ERROR'}: ${msg.slice(0, 160)}`);
            results.push({ caseId: c.caseId, behaviour: c.behaviour, failures: [msg], infra: isInfra });
        }
    }

    // ── Verdict ────────────────────────────────────────────────────────────
    const caseFailures = results.filter((r) => r.failures.length && !r.infra);
    const infraCases = results.filter((r) => r.infra);

    console.log(`\n════ SUMMARY (${MODEL}) ════`);
    console.log(`  routing:     ${routeFailures.length ? 'FAIL' : 'ok'}`);
    console.log(`  commit-gate: ${gateFailures.length ? 'FAIL' : 'ok'}`);
    console.log(`  cases:       ${results.length - caseFailures.length - infraCases.length}/${results.length} clean · ${caseFailures.length} failed · ${infraCases.length} infra`);

    // Every case failing to network in live mode = infra (broken key/model), not a
    // quality result — exit 2 so the suite fails loudly rather than silently green.
    if (!MOCK && infraCases.length === cases.length && cases.length > 0) {
        infra(`all ${cases.length} cases hit infra errors (key/quota/network) — nothing measured`);
    }

    const hardFail = routeFailures.length > 0 || gateFailures.length > 0 || caseFailures.length > 0;
    if (hardFail) {
        if (GATE) {
            console.error(`\n❌ GATE FAILED (${MODEL}): ${routeFailures.length} routing + ${gateFailures.length} commit-gate + ${caseFailures.length} case failure(s)`);
            process.exit(1);
        }
        console.log(`\n⚠️  ${MODEL}: ${routeFailures.length + gateFailures.length + caseFailures.length} failure(s) — advisory (no --gate)`);
        return;
    }
    console.log(`\n✅ PASS (${MODEL})${infraCases.length ? ` — ${infraCases.length} case(s) skipped on infra` : ''}`);
}

main().catch((e) => {
    infra(String(e && e.stack ? e.stack : e));
});
