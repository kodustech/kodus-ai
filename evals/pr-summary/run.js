/**
 * PR-SUMMARY eval — guards the "generate PR summary on open" feature.
 *
 * WHY THIS EXISTS: a prod incident where the summary path silently routed to a
 * hardcoded Google Gemini default with no BYOK/key and every client lost their
 * PR summary — and NO eval caught it. The review agents kept working (they
 * resolve BYOK themselves), so the model matrix stayed green while summaries
 * were dead.
 *
 * Each case runs production's summary step itself: the pipeline stage
 * (UpdateCommentsAndGenerateSummaryStage) with the real CommentManagerService,
 * on a pipeline context that carries the case's PR, its review's comments
 * (lineComments, prLevelCommentResults) and the team's summary config. The
 * model is the org's, routed by production's PermissionValidationService
 * (resolveTaskSlot for the prSummary task) over the case's stored BYOK config,
 * or the org's route for the run's model (evals/shared/model-route.js). The only stand-ins are the code host: the PR
 * body it returns and the description it receives (recorded after the GitHub
 * adapter's own fitPRDescription), and the full PR diff a commit run fetches
 * (the case's files).
 *
 * Checks: a non-empty summary when the config asks for one and none when it
 * does not, posted back to the PR, composed per behaviour, sent to the model the
 * org's routing picks (read off the call itself), and on a real model about what
 * the diff does.
 *
 *   node evals/pr-summary/run.js [--model=<id>] [--gate] [--output=<file>]
 *                                [--behaviour=replace|concatenate|complement|none]
 *                                [--dataset=cases] [--limit=N]
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
const GATE = !!args.gate;
const DATASET = String(args.dataset || 'cases').replace(/\.json$/, '');
const BEHAVIOUR_FILTER = args.behaviour ? String(args.behaviour) : null;
const LIMIT = args.limit ? Number(args.limit) : undefined;
if (args.mock) {
    console.error('--mock was removed: the scripted model (--model=eval-fake) runs the real route without a key');
    process.exit(2);
}
const REAL_MODEL = MODEL !== 'eval-fake';
// The contract is binary: with no floor set for a model, any failed check fails the gate.
const TARGET = (require('./targets.json').models || {})[MODEL] || {};
const FLOOR = TARGET.floor ?? 1;

const START = '<!-- kody-pr-summary:start -->';
const END = '<!-- kody-pr-summary:end -->';

const { TIER0 } = require('../shared/tier0-models');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { countTokens, tokensUsed } = require('../shared/eval-kit');

// exit-2 helper — infra errors ALWAYS fail (a broken model must never look green).
function infra(msg) {
    console.error(`\n❌ INFRA ERROR: ${msg}`);
    process.exit(2);
}

// ── The org's model, routed as production routes it (evals/shared/model-route.js):
//    none stored on the managed default, a BYOK config for any other model. ──
const { resolveRoute, EVAL_ORG, storedByokConfigOf, tier0ModelEntry, evalPermissionService } = require('../shared/model-route');
let ROUTE;
try {
    ROUTE = resolveRoute({ provider: 'tier0', model: MODEL });
} catch (e) {
    infra(`cannot route model '${MODEL}': ${e.message}`);
}
countTokens();

// Every model call the summary makes, as production's LLM port reports it
// (model, routed task, the BYOK model id it came from). Observed, not changed.
const { getLlmObservability, setLlmObservability } = require('../../libs/llm/llm-observability.ts');
let modelCalls = [];
{
    const port = getLlmObservability();
    setLlmObservability({
        ...port,
        runAiSdkLLMInSpan: (params) => {
            modelCalls.push({ model: params.model, route: params.route, byokModelId: params.byokModelId, runName: params.runName });
            return port.runAiSdkLLMInSpan(params);
        },
    });
}

// Prompt seen by the model + the last model-call error, captured via the
// service's own runSummaryPromptV5 seam (see buildService). generateSummaryPR
// swallows model errors (retries, then returns null), so we grab the real error
// here to tell a transient infra failure apart from a genuine empty-summary bug.
let lastPromptSeen = null;
let lastModelError = null;

const INFRA_RE = /quota|rate.?limit|429|timeout|cannot connect|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|api key|unauthorized|forbidden|permission|denied|access|401|403|invalid.*(key|authentication)|overloaded|503|502|depleted|prepayment|insufficient|exhausted|resource_exhausted|billing|payment required|more credits|can only afford/i;
// Classify from the whole error, not just .message — provider SDK errors carry
// the real cause in statusCode / responseBody (e.g. Google's 403 PERMISSION_DENIED
// puts "denied access" in the body, a generic string in .message).
const isInfraErr = (e) => {
    if (!e) return false;
    const parts = [e.message, e.statusCode, e.responseBody, e.data && JSON.stringify(e.data)];
    return INFRA_RE.test(parts.filter(Boolean).join(' '));
};

const { CommentManagerService } = require(
    '../../libs/code-review/infrastructure/adapters/services/commentManager.service.ts',
);
const { BehaviourForExistingDescription } = require(
    '../../libs/core/domain/enums/code-review.enum.ts',
);
const { PlatformType } = require(
    '../../libs/core/domain/enums/platform-type.enum.ts',
);
const { UpdateCommentsAndGenerateSummaryStage } = require(
    '../../libs/code-review/pipeline/stages/finish-comments.stage.ts',
);
const { frozenContext } = require(
    '../../test/fixtures/frozen-pipeline-context.ts',
);
const { PullRequestMessageStatus } = require(
    '../../libs/core/infrastructure/config/types/general/pullRequestMessages.type.ts',
);
const { fitPRDescription } = require('../../libs/code-review/utils/fit-pr-description.ts');

const REPOSITORY = { name: 'sample', id: 'repo-id' };

// ── The real CommentManagerService. On the summary path it reads only the code
//    host (PR body in, description out) and the org's permission service; the
//    other injected services are not reached there, so none is supplied. The
//    code host is the eval's: it returns the case's PR body and records what
//    the GitHub adapter would post (github.service.ts runs fitPRDescription on
//    it first). ──────────────────────────────────────────────────────────────
function buildService(existingBody, postedRef, storedConfig) {
    const codeManagementService = {
        getPullRequestByNumber: async () => ({ body: existingBody }),
        updateDescriptionInPullRequest: async (params) => {
            postedRef.calls += 1;
            postedRef.body = fitPRDescription(params?.summary, PlatformType.GITHUB);
        },
    };
    const service = new CommentManagerService(
        /* parametersService          */ undefined,
        /* messageProcessor           */ undefined,
        /* observabilityService       */ undefined,
        /* permissionValidationService*/ evalPermissionService(storedConfig),
        /* codeManagementService      */ codeManagementService,
    );

    // Observe the prompt and the model error at the service's own seam: the
    // wrapper records and delegates. generateSummaryPR swallows model errors
    // (retries, then returns null), so the error is kept here to tell a
    // transient infra failure apart from a genuine empty-summary bug.
    const realRunSummaryPromptV5 = service.runSummaryPromptV5.bind(service);
    service.runSummaryPromptV5 = async (params) => {
        lastPromptSeen = {
            system: params?.systemPrompt ?? '',
            prompt: params?.userPrompt ?? '',
        };
        try {
            return await realRunSummaryPromptV5(params);
        } catch (e) {
            lastModelError = e;
            throw e;
        }
    };
    // And what the stage got back from it (the description before posting).
    const realGenerate = service.generateSummaryPR.bind(service);
    service.generateSummaryPR = async (...a) => {
        generated.calls += 1;
        generated.isCommitRun = a[6];
        generated.description = await realGenerate(...a);
        return generated.description;
    };
    return service;
}
let generated = { calls: 0, description: null, isCommitRun: null };

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

// A review comment as the pipeline carries it (CommentResult): the finding and
// whether it reached the PR.
const commentResult = (f) => ({ comment: { suggestion: f }, deliveryStatus: f.deliveryStatus || 'sent' });

// The case's stored BYOK config: its models (each a tier-0 model id, or another
// model id on the same route) and routing. None: the org's route for the run's
// model.
function storedConfigOf(c) {
    if (!c.storedConfig) return ROUTE.storedConfig;
    const models = c.storedConfig.models.map((m) => {
        const entry = tier0ModelEntry(m.id, MODEL);
        return m.model ? { ...entry, model: m.model } : entry;
    });
    return storedByokConfigOf(models, c.storedConfig.routing);
}

// The model the org's routing should pick for the summary, as the call names it.
function expectedModelOf(c) {
    if (!c.storedConfig) return { model: TIER0[MODEL]?.doModel || MODEL, byokModelId: ROUTE.storedConfig?.routing.defaultModelId };
    const routing = c.storedConfig.routing || {};
    const id = routing.taskOverrides?.prSummary || routing.defaultModelId || c.storedConfig.models[0].id;
    const m = c.storedConfig.models.find((x) => x.id === id);
    return { model: m.model || TIER0[MODEL]?.doModel || MODEL, byokModelId: id };
}

async function runCase(c) {
    // mode 'open' (first-open, default) drives behaviourForExistingDescription;
    // mode 'commit' (new push on an already-open PR) drives behaviourForNewCommits.
    const isCommitRun = c.mode === 'commit';
    const summaryConfig = { generatePRSummary: c.generatePRSummary !== false };
    if (isCommitRun) {
        // Enum values equal the lowercase strings (replace/concatenate/none).
        summaryConfig.behaviourForNewCommits = c.behaviour;
    } else {
        const behaviourEnum = BEHAVIOUR_ENUM[c.behaviour];
        if (!behaviourEnum) throw new Error(`unknown behaviour '${c.behaviour}' in case ${c.caseId}`);
        summaryConfig.behaviourForExistingDescription = behaviourEnum;
    }

    const posted = { calls: 0, body: null };
    generated = { calls: 0, description: null, isCommitRun: null };
    const service = buildService(c.existingBody || '', posted, storedConfigOf(c));
    lastPromptSeen = null;
    lastModelError = null;
    modelCalls = [];

    // Production's summary step on the case's pipeline context. A commit run
    // with REPLACE fetches the PR's full diff from the code host: the case's
    // files are that diff.
    const pullRequestManagerService = {
        getChangedFilesMetadata: async () => c.changedFiles,
    };
    const stage = new UpdateCommentsAndGenerateSummaryStage(service, pullRequestManagerService, undefined);
    const after = await stage.executeStage(
        frozenContext({
            lastExecution: isCommitRun ? { id: 'previous-review' } : undefined,
            errors: [],
            codeReviewConfig: { languageResultPrompt: 'en-US', summary: summaryConfig },
            repository: REPOSITORY,
            pullRequest: c.pr,
            organizationAndTeamData: EVAL_ORG,
            platformType: PlatformType.GITHUB,
            initialCommentData: { commentId: 1, noteId: 2, threadId: 3 },
            changedFiles: c.changedFiles,
            dryRun: { enabled: false },
            externalPromptContext: undefined,
            lineComments: (c.review?.lineComments || []).map(commentResult),
            prLevelCommentResults: (c.review?.prLevelComments || []).map(commentResult),
            // The end-review message is another step; the stage returns right
            // after the summary when it is inactive.
            pullRequestMessagesConfig: {
                endReviewMessage: { status: PullRequestMessageStatus.INACTIVE },
            },
        }),
    );
    const stageError = (after?.errors || []).find((e) => e?.stage === stage.stageName);
    if (stageError && !lastModelError) lastModelError = stageError.error;
    const finalDescription = generated.description;

    const exp = c.expect || {};
    const checks = [];
    // `quality`: a check on the model's prose, not on the contract (see the gate).
    const check = (what, ok, quality = false) => checks.push({ what, ok: !!ok, ...(quality ? { quality: true } : {}) });
    const done = (contentLen, extra = {}) => ({ caseId: c.caseId, behaviour: c.behaviour, contentLen, checks, failures: checks.filter((x) => !x.ok).map((x) => x.what), ...extra });

    // 0) A config that asks for no summary: the stage makes no call and posts
    // nothing (summary off, or a new commit with behaviourForNewCommits NONE).
    if (exp.generates === false) {
        check('no summary generated when the config asks for none (no model call)', generated.calls === 0 && modelCalls.length === 0);
        check('nothing posted to the PR', posted.calls === 0);
        return done(0);
    }

    // 1) generated + non-empty. Empty ⇒ return NOW — every later assertion
    // dereferences finalDescription, which is null here.
    const content = blockContent(finalDescription || '');
    if (!finalDescription || !content) {
        // Empty summary from a swallowed model error that looks transient/env is
        // INFRA (bad key / quota / network / access), not a quality regression —
        // don't turn eval-env noise into a red gate. A genuine empty result (no
        // model error, or a non-infra crash) stays a real failure.
        if (lastModelError && isInfraErr(lastModelError)) {
            return { caseId: c.caseId, behaviour: c.behaviour, contentLen: 0, checks: [], failures: [`infra: ${String(lastModelError.message).slice(0, 120)}`], infra: true };
        }
        check(`summary generated${lastModelError ? ` (model error: ${String(lastModelError.message).slice(0, 120)})` : ''}`, false);
        return done(0);
    }
    check('summary generated', true);

    // The model the call went to, read off the call: the one the org's routing
    // picks for the prSummary task, never a silent swap to one nobody chose
    // (the incident). With a stored config, the routed model id too.
    const want = expectedModelOf(c);
    const named = (m) => (m.byokModelId ? `${m.byokModelId}: ${m.model}` : m.model);
    const wrong = modelCalls.filter((m) => !String(m.model || '').includes(want.model) || (want.byokModelId !== undefined && m.byokModelId !== want.byokModelId));
    check(
        `summary sent to the model the org's routing picks (${named(want)})${wrong.length ? ` — got ${wrong.map(named).join(', ')}` : ''}`,
        modelCalls.length > 0 && !wrong.length,
    );
    if (want.byokModelId) check('routed as the prSummary task', modelCalls.length > 0 && modelCalls.every((m) => m.route === 'prSummary'));
    if (isCommitRun) check('the stage runs it as a commit run', generated.isCommitRun === true);

    // The review's findings reach the prompt as production writes them: each
    // delivered one listed, or the review reported as having found nothing.
    const seenPrompt = `${lastPromptSeen?.system || ''}\n${lastPromptSeen?.prompt || ''}`;
    const delivered = [...(c.review?.lineComments || []), ...(c.review?.prLevelComments || [])].filter((f) => (f.deliveryStatus || 'sent') === 'sent');
    if (delivered.length) {
        check(`the prompt lists the review's ${delivered.length} delivered finding(s)`, delivered.every((f) => seenPrompt.includes(f.oneSentenceSummary)));
    } else if (!(c.review?.lineComments || []).length && !(c.review?.prLevelComments || []).length) {
        check('the prompt says the review found no issues', /found no issues/.test(seenPrompt));
    }

    // 2) posted to the PR (adapter received a non-empty body)
    if (exp.postsSummary) {
        check('summary posted to the PR (updateDescriptionInPullRequest called)', posted.calls >= 1);
        check('posted body carries the summary block', posted.calls >= 1 && posted.body && posted.body.includes(START));
    }

    // 3) composition per behaviour
    if (exp.exactlyOneBlock) check(`exactly 1 summary block (got ${countBlocks(finalDescription)})`, countBlocks(finalDescription) === 1);
    if (exp.bodyPreserved === true) {
        const author = (c.existingBody || '').split('\n').find((l) => l.trim() && !l.includes('kody-pr-summary'));
        if (author) check(`${c.behaviour} keeps the author-written description`, finalDescription.includes(author.trim()));
    }
    if (exp.bodyPreserved === false && c.existingBody) {
        const author = c.existingBody.split('\n').find((l) => l.trim() && !l.includes('kody-pr-summary'));
        if (author) check('REPLACE drops the existing author description', !finalDescription.includes(author.trim()));
    }
    if (exp.staleContentGone) check('stale prior summary block stripped on re-run', !finalDescription.includes(exp.staleContentGone));
    // commit-run CONCATENATE accumulates INSIDE the block: the prior summary
    // content is kept and the new one appended within the same markers.
    if (exp.blockAccumulates) {
        check('CONCATENATE (new commit) keeps the prior summary content', content.includes(exp.blockAccumulates));
        check('CONCATENATE (new commit) appends the new summary to the block', content !== exp.blockAccumulates);
    }

    // 4) COMPLEMENT must feed the existing description into the model prompt
    if (exp.promptContainsExistingBody) {
        const seen = `${lastPromptSeen?.system || ''}\n${lastPromptSeen?.prompt || ''}`;
        check('COMPLEMENT injects the existing description into the prompt', seen.includes((c.existingBody || '').slice(0, 30)));
    }

    // 5) On a real model, the summary says what the diff does: it uses at least
    // one word only the diff holds (parts of the changed files' and code names
    // that the title and the existing description do not carry). A summary
    // written from the title alone has none. The scripted and mock texts name
    // nothing, so the check runs on real models only. With fewer than three such
    // words a good summary can miss them all (a tax-rounding fix whose only one
    // is `rate`), so the check needs three.
    if (REAL_MODEL) {
        // Every line of the title and the description, each as an added line:
        // diffWords reads only those.
        const saidBefore = `${c.pr?.title || ''}\n${c.existingBody || ''}`.split('\n').map((l) => `+${l}`).join('\n');
        const known = new Set(diffWords([{ filename: '', patch: saidBefore }]));
        const only = diffWords(c.changedFiles).filter((w) => !known.has(w));
        const said = only.filter((w) => content.toLowerCase().includes(w));
        if (only.length >= 3) check(`says what the diff does (uses ${said.length ? said.slice(0, 4).join(', ') : 'none'} of: ${only.slice(0, 6).join(', ')})`, said.length >= 1, true);
    }

    return done(content.length);
}

// The words of a diff a summary of it would use: the parts of the changed
// files' names and of the code names on added lines (camelCase and snake_case
// split), lowercase, four letters or more, minus words of any code.
// Words any summary of any change may use: code keywords and the generic
// vocabulary of change (a summary written without the diff still says "update").
const CODE_WORDS = new Set([
    'this', 'that', 'with', 'from', 'const', 'return', 'async', 'await', 'function', 'export', 'import', 'string', 'number', 'value', 'true', 'false', 'null', 'undefined', 'void', 'type', 'interface', 'class', 'else', 'promise', 'catch', 'throw', 'error', 'errors',
    'create', 'update', 'delete', 'remove', 'find', 'list', 'item', 'items', 'data', 'result', 'results', 'message', 'handler', 'store', 'total', 'amount', 'limit', 'round', 'math', 'date', 'time', 'second', 'seconds', 'user', 'users', 'option', 'options', 'opts', 'existing', 'change', 'changes', 'check', 'logic', 'method', 'service', 'file', 'files', 'code', 'test', 'tests',
]);
function diffWords(files) {
    const words = new Set();
    const add = (name) => {
        for (const part of String(name).split(/(?=[A-Z])|[_\W\d]+/)) {
            const w = part.toLowerCase();
            if (w.length >= 4 && !CODE_WORDS.has(w)) words.add(w);
        }
    };
    for (const f of files || []) {
        add(String(f.filename || '').split('/').pop().replace(/\.[^.]+$/, ''));
        for (const line of String(f.patch || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'))) {
            for (const m of line.matchAll(/[A-Za-z_][\w]*/g)) add(m[0]);
        }
    }
    return [...words];
}

async function main() {
    const cases = require(`./datasets/${DATASET}.json`)
        .filter((c) => !BEHAVIOUR_FILTER || c.behaviour === BEHAVIOUR_FILTER)
        .slice(0, LIMIT);
    if (!cases.length) infra(`no cases in dataset '${DATASET}'${BEHAVIOUR_FILTER ? ` for behaviour '${BEHAVIOUR_FILTER}'` : ''}`);

    console.log(`════ PR-summary eval · model=${MODEL} · ${cases.length} cases ════\n`);

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
            const isInfra = isInfraErr(e);
            console.log(`${isInfra ? '⚠️ ' : '❌'} ${c.caseId.padEnd(26)} [${c.behaviour}] ${isInfra ? 'INFRA' : 'ERROR'}: ${msg.slice(0, 160)}`);
            results.push({ caseId: c.caseId, behaviour: c.behaviour, checks: [], failures: [msg], infra: isInfra, errored: true });
        }
    }

    // ── Verdict ────────────────────────────────────────────────────────────
    const caseFailures = results.filter((r) => r.failures.length && !r.infra);
    const infraCases = results.filter((r) => r.infra);

    console.log(`\n════ SUMMARY (${MODEL}) ════`);
    console.log(`  cases:       ${results.length - caseFailures.length - infraCases.length}/${results.length} clean · ${caseFailures.length} failed · ${infraCases.length} infra`);

    // Every case failing to network in live mode = infra (broken key/model), not a
    // quality result — exit 2 so the suite fails loudly rather than silently green.
    if (infraCases.length === cases.length && cases.length > 0) {
        infra(`all ${cases.length} cases hit infra errors (key/quota/network) — nothing measured`);
    }

    // The shared result (evals/shared/eval-result.js): every dataset case with its checks.
    const asCase = (id, checks, what) => ({ id, checks: what, hits: checks.filter((x) => x.ok).length, total: checks.length, detail: checks });
    const evalCases = [
        ...results.map((r) => {
            const c = cases.find((x) => x.caseId === r.caseId) || {};
            const what = String(c.description || `${r.behaviour} summary`).slice(0, 160);
            return r.infra || r.errored ? { id: r.caseId, checks: what, hits: 0, total: 0, unmeasured: true } : asCase(r.caseId, r.checks, what);
        }),
    ];
    const hits = evalCases.reduce((n, x) => n + x.hits, 0);
    const total = evalCases.reduce((n, x) => n + x.total, 0);
    // A model with a floor of its own was calibrated with the diff check in the
    // number. One without is gated on the contract alone (routing, posting,
    // composition): the diff check reads the model's prose and is reported only,
    // and the result publishes the number the gate read, so whoever reads the
    // result (evals/shared/nightly-verdict.js) judges what the exit code did.
    const calibrated = TARGET.floor !== undefined;
    const gated = evalCases.flatMap((x) => x.detail || []).filter((d) => calibrated || !d.quality);
    const gatedHits = gated.filter((d) => d.ok).length;
    const result = {
        eval: 'pr-summary',
        question: evalQuestion('evals/pr-summary'),
        model: MODEL,
        runs: 1,
        metric: calibrated
            ? { name: 'of PR-summary checks passed', value: total ? hits / total : null, floor: FLOOR, baseline: TARGET.observed ?? null }
            : { name: 'of PR-summary contract checks passed (the diff check reported only)', value: gated.length ? gatedHits / gated.length : null, floor: FLOOR, baseline: null },
        cases: evalCases,
        tokens: tokensUsed(),
        infra: { errored: infraCases.length + results.filter((r) => r.errored && !r.infra).length, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    const problems = resultProblems(result);
    if (problems.length) infra(`the result breaks the shared shape — ${problems.join('; ')}`);
    // A case that crashed is out of the number: past the 5% budget the run did
    // not measure (evals/README.md), engine break or not.
    if (result.infra.errored > cases.length * 0.05) {
        infra(`${result.infra.errored} of ${cases.length} cases did not run (see above)`);
    }

    if (!calibrated && gated.length < total) {
        console.log(`  diff check: ${hits - gatedHits}/${total - gated.length} passed — reported, not gated (no floor for ${MODEL} in targets.json)`);
    }

    if (result.metric.value < FLOOR) {
        if (GATE) {
            console.error(`\n❌ GATE FAILED (${MODEL}): ${gatedHits}/${gated.length} gated checks, below the floor — ${caseFailures.length} case failure(s)`);
            process.exit(1);
        }
        console.log(`\n⚠️  ${MODEL}: ${total - hits} failed check(s) — advisory (no --gate)`);
        return;
    }
    console.log(`\n✅ PASS (${MODEL}): ${hits}/${total} checks${infraCases.length ? ` — ${infraCases.length} case(s) skipped on infra` : ''}`);
}

// Exit explicitly: the engine services it loads can leave a handle open, and a
// finished eval that never exits hangs its CI job until the timeout.
main()
    .then(() => process.exit(0))
    .catch((e) => {
        infra(String(e && e.stack ? e.stack : e));
    });
