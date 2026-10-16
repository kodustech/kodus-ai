// One pull request through production's review, from the platform data on.
//
// What runs is production's code, in production's order:
//   CodeBaseConfigService.getConfig       the team's review config (defaults,
//                                         stored overrides, memories filtered
//                                         by KodyRulesValidationService)
//   routeCodeReviewModel                  the model ValidateConfigStage routes
//   FetchChangedFilesStage                the changed files, filtered and
//                                         rendered with line numbers
//   LocalSandboxService                   the checkout at the PR's head, with
//     .createSandboxWithRepo              grep, read, listDir and exec
//   AgentReviewStage                      the agents, then the anchoring, the
//                                         repeat drop, dedup, severity and the
//                                         formatter
//
// The eval supplies data, and only data, through the services production reads
// it from: the team's stored parameters and rules, the PR's files and commits
// as the platform adapter returns them (evals/investigation/fetch-pr-data.js),
// the repository (a mirror of the platform's refs, evals/shared/repo-mirror.js),
// an org's stored model config (evals/shared/model-route.js). Sinks production
// writes to (the execution log, the cache) keep nothing. Each one is named
// below with what production reads or writes there.
//
// What the review produced is read off the context the stage returns
// (validSuggestions, validSuggestionsByPR: what the later stages post), and
// every agent loop it ran is observed by wrapping runAgentLoopViaCore's export
// without changing its result.
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { mirrorFor, inlineMirror, contentAt } = require('./repo-mirror');
const { EVAL_ORG } = require('./model-route');

const LIBS = path.join(__dirname, '../../libs');
const lib = (p) => require(path.join(LIBS, p));

// ── Observation ─────────────────────────────────────────────────────────────
// One store per review (AsyncLocalStorage): `loops` gets every agent loop the
// review ran ({ params, result }); `agentLoop`, when set, runs in place of the
// loop (the funnel's verify eval: production's verify on frozen candidates,
// with the agent's own runner and tools); `steps`, when set, gets what each
// post-agent step received and returned (observeTheReview).
const observedLoops = new AsyncLocalStorage();
// The agent loop running now: which agent, on which files.
const currentLoop = new AsyncLocalStorage();
const loopKey = (params) => `${params.agentName}|${(params.changedFiles || []).map((f) => f.filename).sort().join(',')}`;
let loopObserved = false;
function observeTheLoop() {
    if (loopObserved) return;
    const adapterPath = require.resolve(path.join(LIBS, 'code-review/infrastructure/agents/core/core-agent-loop.adapter.ts'));
    const real = require(adapterPath);
    require.cache[adapterPath].exports = {
        ...real,
        runAgentLoopViaCore: async (params, secrets) => {
            const store = observedLoops.getStore();
            const result = await currentLoop.run({ key: loopKey(params) }, () =>
                store?.agentLoop ? store.agentLoop(params, secrets) : real.runAgentLoopViaCore(params, secrets),
            );
            store?.loops.push({ params, result });
            return result;
        },
    };
    loopObserved = true;
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/**
 * Records, into the review's store `steps`, what each post-agent step of
 * AgentReviewStage received and returned, what each agent's findings were
 * before the path check (mapAgentFindings), and for each agent loop what its
 * verify step got: the candidates it judged first and the files the finder
 * investigated (the evidence gate's input). Wraps each function without
 * changing its arguments or result.
 */
let reviewObserved = false;
function observeTheReview() {
    if (reviewObserved) return;
    observeTheLoop();
    const steps = () => observedLoops.getStore()?.steps;
    const { AgentReviewStage } = lib('code-review/pipeline/stages/agent-review.stage.ts');
    // A sync method stays sync, an async one async: the wrapper returns what
    // the method returns.
    const wrap = (method, record) => {
        const original = AgentReviewStage.prototype[method];
        AgentReviewStage.prototype[method] = function observed(...args) {
            const store = steps();
            const input = store ? clone(args) : null;
            const out = original.apply(this, args);
            if (!store) return out;
            if (out && typeof out.then === 'function') {
                return out.then((value) => {
                    store[method] = record(input, clone(value));
                    return value;
                });
            }
            store[method] = record(input, clone(out));
            return out;
        };
    };
    wrap('anchorSuggestionsToDiff', ([suggestions, , kodyRules], out) => ({ suggestions, kodyRules, out }));

    // The path check before it: each agent's verified findings through
    // mapAgentFindings (finding-mapper.ts), as the agent provider calls it.
    const mapper = lib('code-review/infrastructure/agents/collaborators/finding-mapper.ts');
    const mapFindings = mapper.mapAgentFindings;
    mapper.mapAgentFindings = (agentResult, ctx) => {
        if (steps()) {
            const { changedFiles, logger, ...params } = ctx;
            (steps().mapper = steps().mapper || []).push({ suggestions: clone(agentResult.findings?.suggestions || []), params: clone(params) });
        }
        return mapFindings(agentResult, ctx);
    };
    wrap('dedupSuggestionStreams', ([suggestions], out) => ({ suggestions, out: out.deduped }));
    wrap('reclassifyAndFilterSeverity', ([suggestions], out) => ({ suggestions, out }));

    // Verify: runFinderWithVerify's first verification pass judges every
    // candidate; the files the finder investigated come off its finder run.
    const finder = lib('code-review/infrastructure/agents/core/finder.agent.ts');
    const passes = lib('agent-harness/infrastructure/orchestration/verification-pass.ts');
    const perRun = new AsyncLocalStorage();
    const runPass = passes.runVerificationPass;
    passes.runVerificationPass = async (args, ctx) => {
        const run = perRun.getStore();
        if (run && !run.candidates) run.candidates = clone(args.candidates);
        return runPass(args, ctx);
    };
    const runFinder = finder.runFinderWithVerify;
    finder.runFinderWithVerify = async (params, input, ctx) => {
        if (!steps()) return runFinder(params, input, ctx);
        const run = { candidates: null };
        const r = await perRun.run(run, () => runFinder(params, input, ctx));
        (steps().verify = steps().verify || []).push({
            loop: currentLoop.getStore()?.key,
            candidates: run.candidates || [],
            investigated: [...finder.strongFilesFromRun(r.finderState)],
        });
        return r;
    };
    reviewObserved = true;
}

// ── The data production reads, held in memory ───────────────────────────────

// The Kody Rules collection of one org, held in memory: the repository
// KodyRulesService writes to and reads from (KODY_RULES_REPOSITORY_TOKEN).
function kodyRulesRepository() {
    const { KodyRulesEntity } = lib('kodyRules/domain/entities/kodyRules.entity.ts');
    let doc = null;
    return {
        findByOrganizationId: async (organizationId) => (doc && doc.organizationId === organizationId ? KodyRulesEntity.create(doc) : null),
        create: async (kodyRules) => {
            doc = { uuid: `eval-kody-rules-${kodyRules.organizationId}`, ...kodyRules };
            return KodyRulesEntity.create(doc);
        },
        addRule: async (_uuid, rule) => {
            doc = { ...doc, rules: [...(doc.rules || []), rule] };
            return KodyRulesEntity.create(doc);
        },
    };
}

/**
 * The team's stored data, where CodeBaseConfigService reads it: its
 * code_review_config parameter (none: a team that kept the defaults), its
 * language_config, and its Kody Rules. Memories are stored as a team member's
 * memory is, through the API's write (KodyRulesService.createOrUpdate, as the
 * create-or-update use case calls it for a memory without centralized config),
 * and read back by the review through the same service.
 *
 * `memories`: [{ title, rule, path? }] as the member wrote them, for every
 * repository ('global').
 */
async function teamStore({ language, memories = [], codeReviewConfig = null }, permissionService) {
    const { ParametersKey } = lib('core/domain/enums/parameters-key.enum.ts');
    const { KodyRulesService } = lib('ee/kodyRules/service/kodyRules.service.ts');
    const { KodyRulesValidationService } = lib('ee/kodyRules/service/kody-rules-validation.service.ts');
    const { KodyRulesType } = lib('kodyRules/domain/interfaces/kodyRules.interface.ts');
    let stored = codeReviewConfig;
    const parametersService = {
        findOne: async ({ configKey }) =>
            configKey === ParametersKey.CODE_REVIEW_CONFIG && stored ? { configValue: stored } : null,
        findByKey: async (key) => (key === ParametersKey.LANGUAGE_CONFIG && language ? { configValue: language } : null),
        // ensureDefaultCodeReviewConfig persists the default for a team with none.
        createActiveVersionIfAbsent: async (_key, _team, configValue) => {
            stored = stored || configValue;
            return { configValue: stored };
        },
    };
    const kodyRulesService = new KodyRulesService(
        kodyRulesRepository(),
        // The audit log's event bus.
        { emit: () => true },
        undefined,
        undefined,
        new KodyRulesValidationService(permissionService),
        undefined,
        undefined,
        permissionService,
        undefined,
        undefined,
    );
    for (const memory of memories) {
        // eslint-disable-next-line no-await-in-loop
        await kodyRulesService.createOrUpdate(
            EVAL_ORG,
            { type: KodyRulesType.MEMORY, title: memory.title, rule: memory.rule, path: memory.path ?? null, repositoryId: 'global' },
            { userId: 'eval-member', userEmail: 'member@example.com' },
        );
    }
    return { parametersService, kodyRulesService };
}

/**
 * The platform as production's code-management service answers for a public
 * GitHub repository: connected, its default branch, no Kodus config file in the
 * repository, the PR's files and commits as the GitHub adapter maps them.
 */
function platform({ baseRef, prFiles, prCommits, content }) {
    return {
        // The file at the PR's head (the finder's context reads it); the
        // repository holds no Kodus config file.
        getRepositoryContentFile: async ({ file }) =>
            /(^|\/)\.?kodus-config\.ya?ml$/.test(String(file?.filename || file?.path || '')) ? null : content(file?.filename || file?.path),
        getRepositoryContentBatch: async () => null,
        verifyConnection: async () => ({ hasConnection: true, isSetupComplete: true }),
        getTypeIntegration: async () => 'GITHUB',
        getDefaultBranch: async () => baseRef,
        getFilesByPullRequestId: async () => prFiles,
        getCommitsForPullRequestForCodeReview: async () => prCommits,
    };
}

// Where production writes and this eval keeps nothing.
const sinks = {
    // AgentReviewStage writes the agents' progress to the execution log.
    automationExecutionService: {
        updateCodeReview: async () => undefined,
        findLatestStageLog: async () => null,
        updateStageLog: async () => undefined,
    },
    cacheService: { getFromCache: async () => null, addToCache: async () => undefined },
};

// ── Production's services over that data ────────────────────────────────────

async function resolveTeamConfig({ permissionService, store, codeManagement, repository, preliminaryFiles }) {
    const CodeBaseConfigService = lib('ee/codeBase/codeBaseConfig.service.ts').default;
    const { KodyRulesValidationService } = lib('ee/kodyRules/service/kody-rules-validation.service.ts');
    const service = new CodeBaseConfigService(
        undefined, // integrationService: not read by getConfig
        undefined, // integrationConfigService: not read by getConfig
        { findByKey: async () => null }, // organizationParametersService: no review-mode or fine-tuning parameter
        store.parametersService,
        store.kodyRulesService,
        { findUpdatedAtByKey: async () => null }, // globalParametersService
        codeManagement,
        new KodyRulesValidationService(permissionService),
        permissionService,
        sinks.cacheService,
    );
    return service.getConfig(EVAL_ORG, repository, preliminaryFiles);
}

function buildAgentReviewStage({ permissionService, codeManagement, previousDecisionsUseCase }) {
    const { AgentReviewStage } = lib('code-review/pipeline/stages/agent-review.stage.ts');
    const { ReviewOrchestratorService } = lib('code-review/infrastructure/agents/review-orchestrator.service.ts');
    const { GeneralistAgentProvider } = lib('code-review/infrastructure/agents/providers/generalist-agent.provider.ts');
    const { BugAgentProvider } = lib('code-review/infrastructure/agents/providers/bug-agent.provider.ts');
    const { SecurityAgentProvider } = lib('code-review/infrastructure/agents/providers/security-agent.provider.ts');
    const { PerformanceAgentProvider } = lib('code-review/infrastructure/agents/providers/performance-agent.provider.ts');
    const { KodyRulesAgentProvider } = lib('code-review/infrastructure/agents/providers/kody-rules-agent.provider.ts');
    const { GraphContextService } = lib('code-review/infrastructure/adapters/services/graph/graph-context.service.ts');
    const { KodusGraphCli } = lib('code-review/infrastructure/adapters/services/graph/kodus-graph-cli.ts');

    const agent = (Provider) => new Provider(permissionService, {}, undefined, undefined);
    const orchestrator = new ReviewOrchestratorService(
        agent(BugAgentProvider),
        agent(SecurityAgentProvider),
        agent(PerformanceAgentProvider),
        agent(GeneralistAgentProvider),
        new KodyRulesAgentProvider(permissionService, {}),
    );
    // No repository record with a ready AST graph: the stage builds the call
    // graph from the checkout (GraphContextService.generateContextLegacy).
    const repositoryService = { findByExternalId: async () => null };
    return new AgentReviewStage(
        sinks.automationExecutionService,
        repositoryService,
        orchestrator,
        undefined, // observabilityService: not read by the stage
        new GraphContextService(undefined, repositoryService, new KodusGraphCli()),
        // featureGate: the org is on no release track, every gated feature off.
        { isEnabled: async () => false },
        { getReleaseTrack: async () => null }, // organizationService
        codeManagement,
        undefined, // kodyRuleSummaryService: rule summaries only shorten long Kody Rules
        undefined, // licenseService: no linked repositories
        previousDecisionsUseCase,
    );
}

async function changedFilesThroughStage(context, codeManagement) {
    const { FetchChangedFilesStage } = lib('code-review/pipeline/stages/fetch-changed-files.stage.ts');
    const { PullRequestHandlerService } = lib('code-review/infrastructure/adapters/services/pullRequestManager.service.ts');
    // Production's service over the platform data: the metadata call, then the
    // content of each changed file.
    const pullRequestManager = new PullRequestHandlerService(codeManagement, sinks.cacheService);
    return new FetchChangedFilesStage(pullRequestManager).execute(context);
}

// The repository the review reads: a mirror of the platform's refs for the PR,
// or a repository written for the eval. `head` is the ref content is read at.
async function repositoryFor({ repo, prNumber, headRef, headSha, baseRef, baseSha, repoFiles, repoBase }) {
    if (repoFiles) {
        const inline = await inlineMirror(repoFiles, { base: repoBase });
        return { cloneUrl: inline.cloneUrl, branch: inline.branch, baseBranch: inline.base, head: inline.branch, prNumber: undefined, commit: false, cleanup: inline.cleanup };
    }
    const cloneUrl = await mirrorFor({ repo, prNumber, headSha, baseRef, baseSha });
    return { cloneUrl, branch: headRef, baseBranch: baseRef, head: prNumber ? `refs/pull/${prNumber}/head` : `refs/eval/${headSha}`, prNumber: prNumber || undefined, commit: !prNumber && !!headSha, headSha, cleanup: async () => undefined };
}

async function checkout(repository) {
    const { LocalSandboxService } = lib('sandbox/infrastructure/providers/local-sandbox.service.ts');
    const sandbox = await new LocalSandboxService(undefined).createSandboxWithRepo({
        cloneUrl: repository.cloneUrl,
        branch: repository.branch,
        baseBranch: repository.baseBranch,
        prNumber: repository.prNumber,
        platform: 'github',
        // A change reviewed from a commit (no PR): the CLI path checks out the SHA.
        ...(repository.commit ? { checkoutSha: repository.headSha } : {}),
    });
    // The lease manager carries the base branch on the instance it hands the
    // pipeline (sandbox-lease-manager.service.ts buildSandboxInstance).
    sandbox.baseBranch = repository.baseBranch;
    const cleanup = sandbox.cleanup;
    sandbox.cleanup = async () => {
        await cleanup();
        await repository.cleanup();
    };
    return sandbox;
}

// The team's config as getConfig resolves it, with the codeReview task's model
// routed as ValidateConfigStage routes it.
async function routedTeamConfig({ team, route, permissionService, codeManagement, repository, preliminaryFiles }) {
    const { routeCodeReviewModel } = lib('code-review/pipeline/stages/route-code-review-model.ts');
    const store = await teamStore(team, permissionService);
    const codeReviewConfig = await resolveTeamConfig({ permissionService, store, codeManagement, repository, preliminaryFiles });
    const routed = routeCodeReviewModel(route.storedConfig, codeReviewConfig);
    codeReviewConfig.resolvedModelSlot = routed.resolvedModelSlot;
    codeReviewConfig.byokConfig = routed.resolvedModelSlot;
    return codeReviewConfig;
}

/**
 * What the steps after the agents read for findings that come with no PR (a
 * dataset of findings): the team's config and routed model as above, over a
 * repository with no Kodus config file, on PR 1. Returns the context and the
 * platform, for buildAgentReviewStage.
 */
async function teamContext({ team = {}, route, permissionService }) {
    const codeManagement = platform({ baseRef: 'main', prFiles: [], prCommits: [], content: async () => null });
    const codeReviewConfig = await routedTeamConfig({
        team,
        route,
        permissionService,
        codeManagement,
        repository: { id: 'eval-findings', name: 'findings' },
        preliminaryFiles: [],
    });
    return { context: { organizationAndTeamData: EVAL_ORG, codeReviewConfig, pullRequest: { number: 1 } }, codeManagement };
}

/**
 * One PR up to the agents, as production prepares it: the team's config, the
 * routed model, the context ValidateConfigStage and FetchChangedFilesStage
 * leave. `pr` is the platform's data:
 *   { repo, number, title, body, headRef, headSha, baseRef, baseSha, files, commits,
 *     repoFiles?, repoBase? (a repository written for the eval, its head and
 *     base trees, instead of `repo`; `files` then come from filesBetween) }
 * `team`: { language, memories, codeReviewConfig } as the team set them.
 * Returns the context, the repository to check out, the platform, and the
 * cleanup of a repository written for the eval.
 */
async function prepareReview({ pr, team = {}, route, permissionService, previousDecisions }) {
    const repository = {
        id: `eval-${(pr.repo || 'inline/repo').replace('/', '-')}`,
        name: (pr.repo || 'inline/repo').split('/')[1],
        fullName: pr.repo || 'inline/repo',
        defaultBranch: pr.baseRef || 'main',
    };
    const repo = await repositoryFor({
        repo: pr.repo,
        prNumber: pr.number,
        headRef: pr.headRef,
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        baseSha: pr.baseSha,
        repoFiles: pr.repoFiles,
        repoBase: pr.repoBase,
    });
    try {
        const codeManagement = platform({
            baseRef: pr.baseRef || repo.baseBranch || 'main',
            prFiles: pr.files,
            prCommits: pr.commits || [],
            content: (file) => contentAt(repo.cloneUrl, repo.head, file),
        });
        const codeReviewConfig = await routedTeamConfig({
            team,
            route,
            permissionService,
            codeManagement,
            repository: { id: repository.id, name: repository.name },
            preliminaryFiles: pr.files,
        });

        let context = {
            organizationAndTeamData: EVAL_ORG,
            platformType: 'github',
            repository,
            branch: pr.headRef,
            pullRequest: {
                number: pr.number || 1,
                title: pr.title,
                body: pr.body,
                head: { ref: pr.headRef, sha: pr.headSha },
                base: { ref: pr.baseRef || 'main', repo: { fullName: repository.fullName } },
            },
            codeReviewConfig,
            // ValidateNewCommitsStage on a first review: every commit of the PR.
            prAllCommits: pr.commits || [],
            prCommits: pr.commits || [],
            previousDecisions,
            pipelineMetadata: {},
        };
        context = await changedFilesThroughStage(context, codeManagement);
        return { context, repo, codeManagement, cleanup: repo.cleanup };
    } catch (error) {
        await repo.cleanup();
        throw error;
    }
}

/**
 * Reviews one PR as production does (prepareReview, then the checkout and
 * AgentReviewStage). Returns what the stage hands to posting, what it
 * discarded, the agent loops it ran, and the context.
 *
 * agentLoop: (params, secrets) => output, run in place of each agent loop.
 * observeSteps: record what each post-agent step received (observeTheReview).
 */
async function reviewPullRequest({ pr, team = {}, route, permissionService, previousDecisions, previousDecisionsUseCase, agentLoop, observeSteps }) {
    observeTheLoop();
    if (observeSteps) observeTheReview();
    const { context, repo, codeManagement } = await prepareReview({ pr, team, route, permissionService, previousDecisions });
    if (!context.changedFiles?.length) {
        await repo.cleanup();
        return { shipped: [], discarded: [], loops: [], context, skipped: context.statusInfo?.message || 'no files to review' };
    }

    const sandbox = await checkout(repo);
    try {
        const stage = buildAgentReviewStage({ permissionService, codeManagement, previousDecisionsUseCase });
        const store = { loops: [], agentLoop, steps: observeSteps ? {} : undefined };
        const out = await observedLoops.run(store, () => stage.execute({ ...context, sandboxHandle: sandbox }));
        return {
            shipped: [...(out.validSuggestions || []), ...(out.validSuggestionsByPR || [])],
            discarded: out.discardedSuggestions || [],
            loops: store.loops,
            steps: store.steps,
            context: out,
            errors: out.errors || [],
        };
    } finally {
        await sandbox.cleanup();
    }
}

module.exports = { reviewPullRequest, prepareReview, teamContext, buildAgentReviewStage, observeTheLoop, observeTheReview, observedLoops, loopKey, teamStore, platform, checkout };
