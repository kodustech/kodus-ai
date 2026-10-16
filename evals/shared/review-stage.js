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
const { mirrorFor, inlineMirror } = require('./repo-mirror');
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
function platform({ baseRef, prFiles, prCommits }) {
    return {
        verifyConnection: async () => ({ hasConnection: true, isSetupComplete: true }),
        getTypeIntegration: async () => 'GITHUB',
        getDefaultBranch: async () => baseRef,
        getRepositoryContentFile: async () => null,
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
    const { CodeBaseConfigService } = lib('ee/codeBase/codeBaseConfig.service.ts');
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
    const pullRequestManager = {
        getChangedFilesMetadata: async (org, repository, pullRequest) =>
            codeManagement.getFilesByPullRequestId({ organizationAndTeamData: org, repository, prNumber: pullRequest?.number }),
    };
    return new FetchChangedFilesStage(pullRequestManager).execute(context);
}

async function checkout({ repo, prNumber, headRef, headSha, baseRef, repoFiles }) {
    const { LocalSandboxService } = lib('sandbox/infrastructure/providers/local-sandbox.service.ts');
    let cloneUrl;
    let inline;
    if (repoFiles) {
        inline = await inlineMirror(repoFiles);
        cloneUrl = inline.cloneUrl;
    } else {
        cloneUrl = await mirrorFor({ repo, prNumber, headSha, baseRef });
    }
    const branch = inline ? inline.branch : headRef;
    const baseBranch = inline ? inline.base : baseRef;
    const sandbox = await new LocalSandboxService(undefined).createSandboxWithRepo({
        cloneUrl,
        branch,
        baseBranch,
        prNumber: inline ? undefined : prNumber || undefined,
        platform: 'github',
        // A change reviewed from a commit (no PR): the CLI path checks out the SHA.
        ...(!inline && !prNumber ? { checkoutSha: headSha } : {}),
    });
    // The lease manager carries the base branch on the instance it hands the
    // pipeline (sandbox-lease-manager.service.ts buildSandboxInstance).
    sandbox.baseBranch = baseBranch;
    const cleanup = sandbox.cleanup;
    sandbox.cleanup = async () => {
        await cleanup();
        await inline?.cleanup();
    };
    return sandbox;
}

/**
 * Reviews one PR as production does. `pr` is the platform's data:
 *   { repo, number, title, body, headRef, headSha, baseRef, files, commits,
 *     repoFiles? (a repository written for the eval, instead of `repo`) }
 * `team`: { language, rules, codeReviewConfig } as the team stored them.
 * Returns what the stage hands to posting, what it discarded, the agent loops
 * it ran, and the context.
 */
async function reviewPullRequest({ pr, team = {}, route, permissionService, previousDecisions, previousDecisionsUseCase }) {
    observeTheLoop();
    const { routeCodeReviewModel } = lib('code-review/pipeline/stages/route-code-review-model.ts');
    const repository = {
        id: `eval-${(pr.repo || 'inline/repo').replace('/', '-')}`,
        name: (pr.repo || 'inline/repo').split('/')[1],
        fullName: pr.repo || 'inline/repo',
        defaultBranch: pr.baseRef || 'main',
    };
    const codeManagement = platform({ baseRef: pr.baseRef || 'main', prFiles: pr.files, prCommits: pr.commits || [] });
    const store = teamStore(team);

    const codeReviewConfig = await resolveTeamConfig({
        permissionService,
        store,
        codeManagement,
        repository: { id: repository.id, name: repository.name },
        preliminaryFiles: pr.files,
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
        previousDecisions,
        pipelineMetadata: {},
    };
    context = await changedFilesThroughStage(context, codeManagement);
    if (!context.changedFiles?.length) {
        return { shipped: [], discarded: [], loops: [], context, skipped: context.statusInfo?.message || 'no files to review' };
    }

    const sandbox = await checkout({
        repo: pr.repo,
        prNumber: pr.number,
        headRef: pr.headRef,
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        repoFiles: pr.repoFiles,
    });
    try {
        context = { ...context, sandboxHandle: sandbox };
        const stage = buildAgentReviewStage({ permissionService, codeManagement, previousDecisionsUseCase });
        const loops = [];
        const out = await observedLoops.run(loops, () => stage.execute(context));
        return {
            shipped: [...(out.validSuggestions || []), ...(out.validSuggestionsByPR || [])],
            discarded: out.discardedSuggestions || [],
            loops,
            context: out,
            errors: out.errors || [],
        };
    } finally {
        await sandbox.cleanup();
    }
}

module.exports = { reviewPullRequest, buildAgentReviewStage, observeTheLoop, observedLoops, teamStore, platform, checkout };
