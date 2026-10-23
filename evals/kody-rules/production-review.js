// One review of a kody-rules case as production runs it, from the case's data.
//
// Production's own code does every step: the rules are saved through the
// save-time compile (KodyRuleDetectorCompilerService.compileAndSave: detector,
// file scope, context need) and loaded for review by KodyRulesValidationService
// .filterKodyRules; the pull request is checked out by the self-hosted sandbox
// (LocalSandboxService.createSandboxWithRepo: the PR head, the base branch,
// exec included); the changed files go through FetchChangedFilesStage; and
// AgentReviewStage runs the review: call graph, rule summaries
// (KodyRuleSummaryService), the orchestrator with the Kody Rules agent, and
// every step after it up to the suggestions it keeps.
//
// The eval supplies data only: the team's stored rules and settings, what the
// code host answers about the PR (materialize-cases.js), and stores in memory
// where production writes to a database. The team runs with the generalist's
// categories off (reviewOptions), a configuration production supports, so the
// Kody Rules agent is the only agent and the measure is its own.
const fs = require('fs');
const path = require('path');
const { registerTs } = require('../shared/eval-kit');

registerTs();
const lib = (p) => require(path.join(__dirname, '../../libs', p));

// A UUID: production reads an org's stored config only for one
// (PermissionValidationService.getBYOKConfig).
const EVAL_ORG = {
    organizationId: '00000000-0000-4000-8000-00000000c0de',
    teamId: '00000000-0000-4000-8000-00000000c0df',
};

/** The org's Kody Rules document, where production keeps it in Mongo. */
class InMemoryKodyRulesRepository {
    constructor(organizationId, rules) {
        const { KodyRulesEntity } = lib('kodyRules/domain/entities/kodyRules.entity.ts');
        this.Entity = KodyRulesEntity;
        this.doc = { uuid: 'eval-kody-rules', organizationId, rules: rules.map((r) => ({ ...r })) };
    }

    entity() {
        return this.Entity.create(JSON.parse(JSON.stringify(this.doc)));
    }

    async findByOrganizationId(organizationId) {
        return organizationId === this.doc.organizationId ? this.entity() : null;
    }

    // The repository's per-field $set: an undefined field is left alone.
    async updateRule(uuid, ruleId, updateData) {
        if (uuid !== this.doc.uuid) return null;
        const rule = this.doc.rules.find((r) => r.uuid === ruleId);
        if (!rule) return null;
        for (const [key, value] of Object.entries(updateData || {})) {
            if (value !== undefined) rule[key] = value;
        }
        return this.entity();
    }
}

/** What the code host answers about the case's PR (recorded in the dataset). */
function codeHostData(pr, repoDir) {
    return {
        getFilesByPullRequestId: async () => pr.files.map((f) => ({ ...f })),
        // No batch endpoint: production then reads each file (the REST path).
        getRepositoryContentBatch: async () => null,
        // The file at the PR head, which is the sandbox's checkout, in the
        // shape the GitHub contents API returns.
        getRepositoryContentFile: async ({ file }) => {
            const target = path.join(repoDir, file.filename);
            if (!target.startsWith(repoDir + path.sep) || !fs.existsSync(target)) return null;
            return { data: { content: fs.readFileSync(target).toString('base64'), encoding: 'base64' } };
        },
    };
}

/** Where production writes the review's execution log. Kept, never read back. */
function executionLog() {
    const entries = [];
    return {
        entries,
        updateCodeReview: async (...a) => entries.push({ op: 'updateCodeReview', a }),
        findLatestStageLog: async () => null,
        updateStageLog: async (...a) => entries.push({ op: 'updateStageLog', a }),
    };
}

// Production's PermissionValidationService over the org's stored model config
// (evals/shared/model-route.js: none on the managed default, a BYOK config for
// any other model).
function permissionService(storedConfig) {
    return require('../shared/model-route').evalPermissionService(storedConfig);
}

let observability;
function observabilityService() {
    if (!observability) {
        const { ObservabilityService } = lib('core/log/observability.service.ts');
        // No exporter configured: spans go to the unconfigured global instance,
        // as production's before init. Its constructor registers itself as the
        // LLM port, so the eval's token count registers after it (real-agent.js).
        observability = new ObservabilityService({ get: () => undefined });
    }
    return observability;
}

/**
 * The rules as the team saved them, after production's save-time compile.
 * Compiled once per rule and reused across runs, as production compiles once
 * at save.
 */
async function compileRules(rules, permission) {
    const { KodyRuleDetectorCompilerService } = lib('ee/kodyRules/service/kody-rule-detector-compiler.service.ts');
    const { KodyRulesService } = lib('ee/kodyRules/service/kodyRules.service.ts');
    const repo = new InMemoryKodyRulesRepository(EVAL_ORG.organizationId, rules);
    // Only the rule-update methods run; the other collaborators are for paths
    // the compile never takes.
    const kodyRulesService = new KodyRulesService(repo, undefined, undefined, undefined, undefined, undefined, observabilityService(), permission);
    const compiler = new KodyRuleDetectorCompilerService(permission, observabilityService(), kodyRulesService);
    const outcomes = [];
    for (const rule of rules) {
        // eslint-disable-next-line no-await-in-loop
        const outcome = await compiler.compileAndSave(EVAL_ORG, rule.uuid, rule);
        outcomes.push({ uuid: rule.uuid, ...outcome });
    }
    return { rules: repo.doc.rules, outcomes };
}

/** The rules a review of this repository loads (CodeBaseConfigService.getConfig). */
function loadRulesForReview(savedRules, repositoryId, permission) {
    const { KodyRulesValidationService } = lib('ee/kodyRules/service/kody-rules-validation.service.ts');
    return new KodyRulesValidationService(permission).filterKodyRules(savedRules, repositoryId, undefined, false);
}

async function checkout(pr) {
    const { LocalSandboxService } = lib('sandbox/infrastructure/providers/local-sandbox.service.ts');
    const { PlatformType } = lib('core/domain/enums/platform-type.enum.ts');
    return new LocalSandboxService(undefined).createSandboxWithRepo({
        cloneUrl: `https://github.com/${pr.repositoryFullName}.git`,
        prNumber: pr.number,
        platform: PlatformType.GITHUB,
        branch: pr.headRef,
        baseBranch: pr.baseRef,
    });
}

function agentReviewStage(permission, log) {
    const { AgentReviewStage } = lib('code-review/pipeline/stages/agent-review.stage.ts');
    const { ReviewOrchestratorService } = lib('code-review/infrastructure/agents/review-orchestrator.service.ts');
    const { GeneralistAgentProvider } = lib('code-review/infrastructure/agents/providers/generalist-agent.provider.ts');
    const { BugAgentProvider } = lib('code-review/infrastructure/agents/providers/bug-agent.provider.ts');
    const { SecurityAgentProvider } = lib('code-review/infrastructure/agents/providers/security-agent.provider.ts');
    const { PerformanceAgentProvider } = lib('code-review/infrastructure/agents/providers/performance-agent.provider.ts');
    const { KodyRulesAgentProvider } = lib('code-review/infrastructure/agents/providers/kody-rules-agent.provider.ts');
    const { GraphContextService } = lib('code-review/infrastructure/adapters/services/graph/graph-context.service.ts');
    const { KodusGraphCli } = lib('code-review/infrastructure/adapters/services/graph/kodus-graph-cli.ts');
    const { KodyRuleSummaryService } = lib('kodyRules/infrastructure/adapters/services/kody-rule-summary.service.ts');

    const obs = observabilityService();
    const agent = (Provider) => new Provider(permission, obs);
    const orchestrator = new ReviewOrchestratorService(
        agent(BugAgentProvider),
        agent(SecurityAgentProvider),
        agent(PerformanceAgentProvider),
        agent(GeneralistAgentProvider),
        agent(KodyRulesAgentProvider),
    );
    // The repository has no stored AST graph, so the stage builds the call
    // graph from the checkout (GraphContextService.generateContextLegacy).
    const repositories = { findByExternalId: async () => null, findById: async () => null };
    const graph = new GraphContextService({ exportSubgraphJsonString: async () => null }, repositories, new KodusGraphCli());
    return (rulesRepo) => {
        const stage = new AgentReviewStage(
            log,
            repositories,
            orchestrator,
            obs,
            graph,
            undefined, // feature gate: read only for heavy mode, which the eval does not ask for
            undefined, // organization service: same
            undefined, // code management: read only for linked repositories, off without a license
            new KodyRuleSummaryService(permission, rulesRepo, obs),
        );
        // TEMP_LOG_NEW_FINDER: the eval runs the whole stage.
        stage.tempStopAfterNewFinder = false;
        return stage;
    };
}

/** The changed files production reviews, through FetchChangedFilesStage. */
async function fetchChangedFiles(context, pr, repoDir) {
    const { FetchChangedFilesStage } = lib('code-review/pipeline/stages/fetch-changed-files.stage.ts');
    const { PullRequestHandlerService } = lib('code-review/infrastructure/adapters/services/pullRequestManager.service.ts');
    const stage = new FetchChangedFilesStage(new PullRequestHandlerService(codeHostData(pr, repoDir), undefined));
    return stage.execute(context);
}

/**
 * Reviews one case: returns the suggestions AgentReviewStage keeps (file and
 * PR level), the compile outcomes, the files reviewed, and the sandbox type.
 */
async function reviewCase(c, { rules, compiled, storedConfig = null }) {
    const { getDefaultKodusConfigFile } = lib('common/utils/validateCodeReviewConfigFile.ts');
    const { routeCodeReviewModel } = lib('code-review/pipeline/stages/route-code-review-model.ts');
    const { LanguageValue } = lib('core/domain/enums/language-parameter.enum.ts');
    const { PlatformType } = lib('core/domain/enums/platform-type.enum.ts');
    const pr = c.pr;
    const permission = permissionService(storedConfig);
    const repositoryId = `eval-${pr.repositoryFullName}`;

    const saved = compiled || (await compileRules(rules, permission));
    const { standardRules, memoryRules } = loadRulesForReview(saved.rules, repositoryId, permission);
    const rulesRepo = new InMemoryKodyRulesRepository(EVAL_ORG.organizationId, saved.rules);

    // The team's config: production's default for a team with no saved config
    // (CodeBaseConfigService.getDefaultConfigs), with the generalist's
    // categories off and the rules loaded above.
    const codeReviewConfig = {
        ...getDefaultKodusConfigFile(),
        languageResultPrompt: LanguageValue.ENGLISH,
        reviewOptions: { ...(getDefaultKodusConfigFile().reviewOptions || {}), bug: false, security: false, performance: false },
        kodyRules: standardRules,
        kodyMemoryRules: memoryRules,
        baseBranchDefault: pr.defaultBranch,
    };
    const { resolvedModelSlot } = routeCodeReviewModel(storedConfig, codeReviewConfig);
    codeReviewConfig.resolvedModelSlot = resolvedModelSlot;
    codeReviewConfig.byokConfig = resolvedModelSlot;

    const sandbox = await checkout(pr);
    try {
        let context = {
            organizationAndTeamData: EVAL_ORG,
            platformType: PlatformType.GITHUB,
            repository: { id: repositoryId, name: pr.repositoryFullName.split('/')[1], fullName: pr.repositoryFullName, defaultBranch: pr.defaultBranch },
            pullRequest: {
                number: pr.number,
                title: pr.title,
                body: pr.body,
                base: { ref: pr.baseRef, sha: pr.baseSha, repo: { fullName: pr.repositoryFullName } },
                head: { ref: pr.headRef, sha: pr.headSha },
            },
            prAllCommits: pr.commits,
            codeReviewConfig,
            sandboxHandle: { ...sandbox, baseBranch: pr.baseRef },
            statusInfo: {},
            errors: [],
        };
        context = await fetchChangedFiles(context, pr, sandbox.repoDir);
        const log = executionLog();
        const stage = agentReviewStage(permission, log)(rulesRepo);
        const out = await stage.execute(context);
        return {
            suggestions: [...(out.validSuggestions || []), ...(out.validSuggestionsByPR || [])],
            discarded: out.discardedSuggestions || [],
            files: (context.changedFiles || []).map((f) => f.filename),
            reviewWarnings: out.reviewWarnings || [],
            lastReviewError: out.lastReviewError || null,
            compiled: saved,
            sandboxType: sandbox.type,
        };
    } finally {
        await sandbox.cleanup();
    }
}

module.exports = { reviewCase, compileRules, permissionService, observabilityService, EVAL_ORG, InMemoryKodyRulesRepository };
