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
const { mirrorFor, inlineMirror, contentAt, pullRequestFiles } = require('./repo-mirror');
const { EVAL_ORG } = require('./model-route');

const LIBS = path.join(__dirname, '../../libs');
const lib = (p) => require(path.join(LIBS, p));

// ── Observation ─────────────────────────────────────────────────────────────
const observedLoops = new AsyncLocalStorage();
let loopObserved = false;
function observeTheLoop() {
    if (loopObserved) return;
    const adapterPath = require.resolve(path.join(LIBS, 'code-review/infrastructure/agents/core/core-agent-loop.adapter.ts'));
    const real = require(adapterPath);
    require.cache[adapterPath].exports = {
        ...real,
        runAgentLoopViaCore: async (params, secrets) => {
            const result = await real.runAgentLoopViaCore(params, secrets);
            observedLoops.getStore()?.push({ params, result });
            return result;
        },
    };
    loopObserved = true;
}

// What the Kody Rules agent returned on each review (its warnings say whether
// every rule was judged), observed on the provider without changing it.
const observedRuleReviews = new AsyncLocalStorage();
let rulesObserved = false;
function observeTheRuleAgent() {
    if (rulesObserved) return;
    const { KodyRulesAgentProvider } = lib('code-review/infrastructure/agents/providers/kody-rules-agent.provider.ts');
    const execute = KodyRulesAgentProvider.prototype.execute;
    KodyRulesAgentProvider.prototype.execute = async function observedExecute(...args) {
        const out = await execute.apply(this, args);
        observedRuleReviews.getStore()?.push(out);
        return out;
    };
    rulesObserved = true;
}

// ── The data production reads, held in memory ───────────────────────────────

/**
 * The team's stored data, where CodeBaseConfigService reads it: its
 * code_review_config parameter (none: a team that kept the defaults), its
 * language_config, and its Kody Rules (memories are rules of type memory).
 */
function teamStore({ language, rules = [], codeReviewConfig = null }) {
    const { ParametersKey } = lib('core/domain/enums/parameters-key.enum.ts');
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
    const entity = rules.length ? { toObject: () => ({ rules }) } : null;
    const kodyRulesService = {
        findByOrganizationId: async () => entity,
        // The rules' lock state already matches the plan: nothing to reconcile.
        syncRulesWithPlanLimit: async (_org, { entity: e }) => e,
    };
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

/**
 * The PR's decision store (PrDecisionStore) holding the suggestions Kody posted
 * in earlier rounds, as records production loads them: BuildPreviousReviewDecisionsUseCase
 * reads it for the prompts (LoadExternalContextStage) and for the repeat check
 * (AgentReviewStage), each with its own cap.
 */
function decisionStore(decisions = []) {
    const { BuildPreviousReviewDecisionsUseCase } = lib(
        'code-review/application/use-cases/previousReviewDecisions/build-previous-review-decisions.use-case.ts',
    );
    return new BuildPreviousReviewDecisionsUseCase({ load: async () => decisions });
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

// LoadExternalContextStage over the team's data: no external prompt references
// stored, the Trace context off (no release track), the PR's earlier decisions
// from its decision store.
async function externalContextThroughStage(context, previousDecisionsUseCase) {
    const { LoadExternalContextStage } = lib('code-review/pipeline/stages/load-external-context.stage.ts');
    const { PromptExternalReferenceManagerService } = lib(
        'ai-engine/infrastructure/adapters/services/prompt/promptExternalReferenceManager.service.ts',
    );
    const stage = new LoadExternalContextStage(
        // No context reference stored for the team: every revision read is empty.
        new PromptExternalReferenceManagerService({ getLatestRevision: async () => null, findById: async () => null }),
        undefined, // promptContextLoader: read only for stored references
        undefined, // contextPackService: read only with a contextReferenceId
        undefined, // buildTraceContextPackUseCase: read only with the Trace gate on
        { isEnabled: async () => false }, // featureGate: on no release track
        { getReleaseTrack: async () => null }, // organizationService
        previousDecisionsUseCase,
    );
    return stage.execute(context);
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
async function repositoryFor({ repo, prNumber, headRef, headSha, baseRef, repoFiles, baseFiles }) {
    if (repoFiles) {
        const inline = await inlineMirror(repoFiles, { baseFiles });
        return { cloneUrl: inline.cloneUrl, branch: inline.branch, baseBranch: inline.base, head: inline.branch, prNumber: undefined, commit: false, cleanup: inline.cleanup };
    }
    const cloneUrl = await mirrorFor({ repo, prNumber, headSha, baseRef });
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

/**
 * Reviews one PR as production does. `pr` is the platform's data:
 *   { repo, number, title, body, headRef, headSha, baseRef, files, commits,
 *     repoFiles? (a repository written for the eval, instead of `repo`: the
 *     tree at the PR's head), baseFiles? (that repository's tree before the
 *     PR; its changed files are then the platform's list between the two) }
 * `team`: { language, rules, codeReviewConfig } as the team stored them.
 * `decisions`: the PR's decision store, the suggestions earlier rounds posted
 * (PrDecisionRecord).
 * `sandbox`: 'none' runs the review with no sandbox, as production does when
 * none could be created; `wrapSandbox(handle)` lets an eval make the sandbox
 * fail the way a dead one does (its tools throw), around production's own.
 * Returns what the stage hands to posting, what it discarded, the agent loops
 * it ran, what the Kody Rules agent returned, and the context.
 */
async function reviewPullRequest({ pr, team = {}, route, permissionService, decisions = [], sandbox: sandboxMode = 'alive', wrapSandbox }) {
    observeTheLoop();
    observeTheRuleAgent();
    const { routeCodeReviewModel } = lib('code-review/pipeline/stages/route-code-review-model.ts');
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
        repoFiles: pr.repoFiles,
        baseFiles: pr.baseFiles,
    });
    const prFiles = pr.files || (pr.repoFiles && pr.baseFiles ? await pullRequestFiles(repo.cloneUrl, repo.baseBranch, repo.branch) : []);
    const codeManagement = platform({
        baseRef: pr.baseRef || repo.baseBranch || 'main',
        prFiles,
        prCommits: pr.commits || [],
        content: (file) => contentAt(repo.cloneUrl, repo.head, file),
    });
    const store = teamStore(team);

    const codeReviewConfig = await resolveTeamConfig({
        permissionService,
        store,
        codeManagement,
        repository: { id: repository.id, name: repository.name },
        preliminaryFiles: prFiles,
    });
    // ValidateConfigStage: the codeReview task's routed model.
    const routed = routeCodeReviewModel(route.storedConfig, codeReviewConfig);
    codeReviewConfig.resolvedModelSlot = routed.resolvedModelSlot;
    codeReviewConfig.byokConfig = routed.resolvedModelSlot;

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
        pipelineMetadata: {},
    };
    const previousDecisionsUseCase = decisionStore(decisions);
    context = await changedFilesThroughStage(context, codeManagement);
    if (!context.changedFiles?.length) {
        await repo.cleanup();
        return { shipped: [], discarded: [], loops: [], ruleReviews: [], context, skipped: context.statusInfo?.message || 'no files to review' };
    }
    context = await externalContextThroughStage(context, previousDecisionsUseCase);

    const sandbox = sandboxMode === 'none' ? null : await checkout(repo);
    try {
        if (sandbox) context = { ...context, sandboxHandle: wrapSandbox ? wrapSandbox(sandbox) : sandbox };
        const stage = buildAgentReviewStage({ permissionService, codeManagement, previousDecisionsUseCase });
        const loops = [];
        const ruleReviews = [];
        const out = await observedRuleReviews.run(ruleReviews, () => observedLoops.run(loops, () => stage.execute(context)));
        return {
            shipped: [...(out.validSuggestions || []), ...(out.validSuggestionsByPR || [])],
            // The same, split as posting takes them: comments on files, and on the PR.
            shippedOnFiles: out.validSuggestions || [],
            shippedOnPR: out.validSuggestionsByPR || [],
            discarded: out.discardedSuggestions || [],
            loops,
            ruleReviews,
            context: out,
            errors: out.errors || [],
        };
    } finally {
        if (sandbox) await sandbox.cleanup();
        else await repo.cleanup();
    }
}

module.exports = { reviewPullRequest, buildAgentReviewStage, observeTheLoop, observedLoops, teamStore, platform, checkout };
