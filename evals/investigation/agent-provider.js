require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });

// The current review stack imports BYOK helpers that eagerly load the crypto util.
// The investigation eval does not decrypt org secrets, so a deterministic dummy
// key is enough to let those modules load without requiring full app runtime env.
if (!process.env.API_CRYPTO_KEY) {
    process.env.API_CRYPTO_KEY = '0'.repeat(64);
}

function parseMaybeJson(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;

    if (
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return value;
        }
    }

    return value;
}

function summarizeInput(value) {
    if (value === undefined) return { type: 'undefined' };
    if (value === null) return { type: 'null' };
    if (typeof value === 'string') {
        return {
            type: 'string',
            length: value.length,
            preview: value.slice(0, 180),
        };
    }
    if (Array.isArray(value)) {
        return {
            type: 'array',
            length: value.length,
        };
    }
    if (typeof value === 'object') {
        return {
            type: 'object',
            keys: Object.keys(value).slice(0, 20),
        };
    }

    return { type: typeof value };
}

function normalizePath(value) {
    return String(value || '')
        .replace(/^\/+/, '')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/');
}

function countPatchLines(patch) {
    let additions = 0;
    let deletions = 0;
    for (const line of String(patch || '').split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
    return { additions, deletions };
}

// additions/deletions/status are what production's file scorer ranks by
// (file-priority-scorer.ts:71-74, :158-169); dropping them tied every file.
function normalizeChangedFiles(files) {
    return (files || []).map((file) => {
        const patch = file.patch || file.patchWithLinesStr || file.diff || '';
        const counted = countPatchLines(patch);
        return {
            filename: normalizePath(file.filename || file.path || file.filePath),
            patchWithLinesStr:
                file.patchWithLinesStr || file.patch || file.diff || '',
            patch,
            additions: file.additions ?? counted.additions,
            deletions: file.deletions ?? counted.deletions,
            ...(file.status ? { status: file.status } : {}),
        };
    });
}

function defaultApiKeyEnv(provider) {
    switch (provider) {
        case 'openai':
            return 'API_OPEN_AI_API_KEY';
        case 'openai-compatible':
            return 'API_OPEN_AI_API_KEY';
        case 'anthropic':
            return 'API_ANTHROPIC_API_KEY';
        case 'openrouter':
            return 'API_OPENROUTER_KEY';
        case 'google':
        default:
            return 'API_GOOGLE_AI_API_KEY';
    }
}

// ── The model, routed as production routes it ──────────────────────────────
// Production hands the finder no model. execute() routes the codeReview task to
// a slot (resolveReviewAgentModel → permissionValidationService.resolveTaskSlot,
// model-factory.ts:61-110), and LLM.run builds the model from that slot, or from
// the env/managed default when there is none (ai-sdk-agent-runner.ts:245-246).
// The loop ignores an AgentLoopInput `model` (review-agent.contract.ts:360-362),
// so the model this eval used to build never ran: RECALL_REASONING_EFFORT never
// reached the finder, and an `@sub` model ran the managed default.
//
// So the eval routes the way an org does:
//   - by default no stored config: the env/managed route trial orgs take, with
//     applyModelEnv pointing it at the eval's model;
//   - with RECALL_REASONING_EFFORT, or a promptfoo config that names its own
//     provider: a stored BYOK config (version 2) holding that model, read by
//     production's getBYOKConfig (permissionValidation.service.ts:1170-1186) and
//     routed by resolveTaskSlot, like a customer's BYOK model and its effort.
// The org's stored config is the one thing the eval supplies (the
// organization-parameters read); the routing and the model are production's.

// A UUID: getBYOKConfig reads an org's config only for one
// (permissionValidation.service.ts:1173-1177).
const EVAL_ORG = {
    organizationId: '00000000-0000-4000-8000-00000000e7a1',
    teamId: 'eval-team',
};

// Provider ids of evals/shared/tier0-models.js and the promptfoo configs →
// BYOKProvider (libs/llm/model-providers.ts:15-35).
const BYOK_PROVIDER = {
    google: 'google_gemini',
    openai: 'openai',
    anthropic: 'anthropic',
    openai_compatible: 'openai_compatible',
    'openai-compatible': 'openai_compatible',
    openrouter: 'open_router',
};

/** A model the eval cannot run the way production would: not measured. */
class NotAProductionRoute extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotAProductionRoute';
    }
}

function storedByokConfig({ provider, model, apiKey, baseURL, reasoningEffort, openrouterProviderOrder }) {
    const byokProvider = openrouterProviderOrder?.length ? 'open_router' : BYOK_PROVIDER[provider];
    if (!byokProvider) {
        throw new NotAProductionRoute(`provider '${provider}' has no BYOK route in production`);
    }
    const { encrypt } = require('../../libs/common/utils/crypto.ts');
    return {
        version: 2,
        credentials: [
            {
                id: 'eval-credential',
                provider: byokProvider,
                apiKey: encrypt(apiKey),
                // Where resolveModelSlot reads them (resolve-model-slot.ts:86-99).
                settings: {
                    ...(baseURL ? { baseURL } : {}),
                    ...(openrouterProviderOrder?.length
                        ? { openrouterProviderOrder, openrouterAllowFallbacks: false }
                        : {}),
                },
            },
        ],
        models: [
            {
                id: 'eval-model',
                credentialId: 'eval-credential',
                model,
                ...(reasoningEffort ? { reasoningEffort } : {}),
            },
        ],
        routing: { defaultModelId: 'eval-model' },
    };
}

/**
 * How this run reaches its model: `{ storedConfig, route, modelId, reasoningEffort }`,
 * storedConfig null on the managed route. Throws NotAProductionRoute for a
 * model production cannot run.
 */
function resolveRoute(config) {
    const effort = process.env.RECALL_REASONING_EFFORT || null;
    if (config.provider === 'tier0') {
        const modelId = process.env.RECALL_MODEL || config.model;
        const { applyModelEnv, TIER0 } = require('../shared/tier0-models');
        const spec = TIER0[modelId];
        if (spec && spec.provider === 'codex_subscription') {
            throw new NotAProductionRoute(
                `${modelId} runs on a ChatGPT subscription, which production has no route for ` +
                    '(libs/llm/codex-subscription-model.ts is used only by evals): the finder would run another model',
            );
        }
        // The env the managed route reads, and what the run's other callers
        // (the judge excepted) fall back to.
        applyModelEnv(modelId);
        if (!effort) return { storedConfig: null, route: 'managed', modelId, reasoningEffort: null };
        const key = (spec?.keyEnvs || []).map((name) => process.env[name]).find(Boolean);
        if (!key) {
            throw new Error(
                `RECALL_REASONING_EFFORT routes ${modelId} through a BYOK config, which needs its key (${(spec?.keyEnvs || []).join(', ') || 'none known'})`,
            );
        }
        return {
            storedConfig: storedByokConfig({
                provider: spec.provider,
                model: spec.doModel || modelId,
                apiKey: key,
                baseURL: spec.baseURL,
                reasoningEffort: effort,
                openrouterProviderOrder: spec.openrouterProviderOrder,
            }),
            route: 'byok',
            modelId,
            reasoningEffort: effort,
        };
    }

    // A promptfoo config naming its own provider (promptfoo*.yaml). Env
    // overrides so ANY model runs from one yaml (no per-provider config):
    //   RECALL_MODEL, RECALL_PROVIDER, RECALL_BASEURL, RECALL_APIKEY_ENV.
    if (process.env.RECALL_PROVIDER || process.env.RECALL_BASEURL) {
        config = {
            ...config,
            ...(process.env.RECALL_PROVIDER ? { provider: process.env.RECALL_PROVIDER } : {}),
            ...(process.env.RECALL_BASEURL ? { baseURL: process.env.RECALL_BASEURL } : {}),
        };
    }
    const provider = config.provider || 'google';
    const model = process.env.RECALL_MODEL || config.model;
    const apiKeyEnv = process.env.RECALL_APIKEY_ENV || config.apiKeyEnv || defaultApiKeyEnv(provider);
    const apiKey = config.apiKey || process.env[apiKeyEnv];
    if (!model) throw new Error('Missing provider config.model');
    if (!apiKey) throw new Error(`Missing API key for ${provider} in ${apiKeyEnv}`);
    return {
        storedConfig: storedByokConfig({
            provider,
            model,
            apiKey,
            baseURL: config.baseURL || (provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined),
            reasoningEffort: effort,
            openrouterProviderOrder: Array.isArray(config.providerOrder) ? config.providerOrder.filter(Boolean) : undefined,
        }),
        route: 'byok',
        modelId: model,
        reasoningEffort: effort,
    };
}

// The permission service production routes through, over the eval org's stored
// config: only the organization-parameters read is the eval's.
function evalPermissionService(storedConfig) {
    const { PermissionValidationService } = require(
        path.join(__dirname, '../../libs/ee/shared/services/permissionValidation.service.ts'),
    );
    const { OrganizationParametersKey } = require(
        path.join(__dirname, '../../libs/core/domain/enums/organization-parameters-key.enum.ts'),
    );
    return new PermissionValidationService(undefined, {
        findByKey: async (key) =>
            key === OrganizationParametersKey.BYOK_CONFIG && storedConfig ? { configValue: storedConfig } : null,
    });
}

function fixtureMatches(match, actual) {
    return Object.entries(match || {}).every(([key, expectedValue]) => {
        if (expectedValue === undefined || expectedValue === null) return true;

        if (key === 'pathEndsWith') {
            return normalizePath(actual.path).endsWith(normalizePath(expectedValue));
        }

        if (key === 'patternIncludes') {
            return String(actual.pattern || '').includes(String(expectedValue));
        }

        const actualValue = actual[key];
        if (key.toLowerCase().includes('path')) {
            return normalizePath(expectedValue) === normalizePath(actualValue);
        }
        return expectedValue === actualValue;
    });
}

class ReplayRemoteCommands {
    constructor(replay) {
        this.replay = replay || {};
        this.calls = [];
        this.unexpectedCalls = [];
        this.readFileCorpus = Array.isArray(this.replay.readFile)
            ? this.replay.readFile
                  .map((entry) => ({
                      path: normalizePath(entry?.match?.path),
                      content: String(entry?.result || ''),
                  }))
                  .filter((entry) => entry.path && entry.content)
            : [];
    }

    _findFixture(kind, actual) {
        const entries = this.replay[kind] || [];
        return (
            entries.find((entry) =>
                fixtureMatches(entry.match || {}, actual),
            ) || null
        );
    }

    _recordCall(kind, actual, matched) {
        this.calls.push({ kind, actual, matched });
        if (!matched) {
            this.unexpectedCalls.push({ kind, actual });
        }
    }

    _lookup(kind, actual) {
        const match = this._findFixture(kind, actual);
        this._recordCall(kind, actual, !!match);
        if (!match) {
            return null;
        }

        return match.result || '';
    }

    _matchesPathScope(filePath, searchPath) {
        const normalizedFilePath = normalizePath(filePath);
        const normalizedSearchPath = normalizePath(searchPath || '.');

        if (!normalizedSearchPath || normalizedSearchPath === '.') return true;
        return (
            normalizedFilePath === normalizedSearchPath ||
            normalizedFilePath.startsWith(`${normalizedSearchPath}/`)
        );
    }

    _matchesGlob(filePath, glob) {
        if (!glob) return true;
        const normalizedFilePath = normalizePath(filePath);

        if (/^\*\.[^*]+$/.test(glob)) {
            return normalizedFilePath.endsWith(glob.slice(1));
        }

        return true;
    }

    _compilePattern(pattern) {
        try {
            return new RegExp(String(pattern || ''));
        } catch {
            const escaped = String(pattern || '').replace(
                /[.*+?^${}()|[\]\\]/g,
                '\\$&',
            );
            return new RegExp(escaped);
        }
    }

    _searchReadFileCorpus(actual) {
        const regex = this._compilePattern(actual.pattern);
        const matches = [];

        for (const entry of this.readFileCorpus) {
            if (!this._matchesPathScope(entry.path, actual.path)) continue;
            if (!this._matchesGlob(entry.path, actual.glob)) continue;

            const lines = entry.content.split('\n');
            for (let index = 0; index < lines.length; index += 1) {
                const line = lines[index];
                regex.lastIndex = 0;
                if (!regex.test(line)) continue;

                matches.push(`${entry.path}:${index + 1}:${line}`);
                if (matches.length >= 40) {
                    return matches.join('\n');
                }
            }
        }

        return matches.length ? matches.join('\n') : null;
    }

    async grep(pattern, searchPath, glob) {
        const actual = {
            pattern: pattern || '',
            path: normalizePath(searchPath || '.'),
            glob: glob || '',
        };

        const fixture = this._findFixture('grep', actual);
        if (fixture) {
            this._recordCall('grep', actual, true);
            return fixture.result || '';
        }

        const synthesized = this._searchReadFileCorpus(actual);
        if (synthesized !== null) {
            this.calls.push({
                kind: 'grep',
                actual,
                matched: 'synthetic-readfile-corpus',
            });
            return synthesized;
        }

        this._recordCall('grep', actual, false);
        return 'No matches found.';
    }

    async read(filePath, start, end) {
        const actual = {
            path: normalizePath(filePath),
            startLine: start || 0,
            endLine: end || 0,
        };
        const result = this._lookup('readFile', actual);
        if (result !== null) return result;
        return `No replay fixture matched readFile(${actual.path}, ${actual.startLine}, ${actual.endLine}).`;
    }

    async listDir(dirPath, maxDepth) {
        const actual = {
            path: normalizePath(dirPath || '.'),
            maxDepth: maxDepth || 2,
        };
        const exact = this._findFixture('listDir', actual);
        if (exact) {
            this._recordCall('listDir', actual, true);
            return exact.result || '';
        }

        const relaxed = (this.replay.listDir || []).find(
            (entry) =>
                normalizePath(entry?.match?.path || '.') === actual.path,
        );
        if (relaxed) {
            this.calls.push({
                kind: 'listDir',
                actual,
                matched: 'relaxed-path-only',
            });
            return relaxed.result || '';
        }

        this._recordCall('listDir', actual, false);
        return '';
    }
}

// The input production's execute() hands the agent loop, built with the same
// functions in the same order (base-code-review-agent.provider.ts:127-420, and
// the orchestrator before it). The eval calls the loop itself rather than
// execute() because it scores the finder's own findings (the loop's result),
// before the finding mapper (measured by evals/parse); everything execute()
// does to the input on the way to the loop is reproduced here.
//
// `batch`: one batch of a PR production splits (runChunkedReview,
// batch-runner.ts:86-120): its files, index and total.
async function buildProductionRun(caseData, permissionService, batch) {
    const lib = (p) => require(path.join(__dirname, '../../libs', p));
    const { GeneralistAgentProvider } = lib('code-review/infrastructure/agents/providers/generalist-agent.provider.ts');
    const { ReviewOrchestratorService } = lib('code-review/infrastructure/agents/review-orchestrator.service.ts');
    const { resolveReviewAgentModel } = lib('code-review/infrastructure/agents/collaborators/model-factory.ts');
    const { resolveContextWindow } = lib('llm/model-context-window.ts');
    const { resolveAdaptiveProfile } = lib('code-review/infrastructure/agents/engine/adaptive-fit.ts');
    const planner = lib('code-review/infrastructure/agents/collaborators/context-fit-planner.ts');
    const { assignFileTiers, computeFileScores } = lib('code-review/infrastructure/agents/engine/file-priority-scorer.ts');

    const provider = new GeneralistAgentProvider(permissionService, {}, undefined, undefined);
    // The PR's whole diff, rendered as fetch-changed-files.stage.ts renders it
    // (materialize-full-diff.js on feat/improve-harness-to-big-models).
    // `changedFiles` is the corpus's first field: at most 6 files, tests left
    // out, with no record of the rest. A dataset without the full diff falls
    // back to it.
    const prFiles = normalizeChangedFiles(
        parseMaybeJson(caseData.changedFilesFull) || parseMaybeJson(caseData.changedFiles),
    );
    const reviewMode = caseData.reviewMode || 'normal';
    let input = {
        organizationAndTeamData: EVAL_ORG,
        changedFiles: batch ? batch.changedFiles : prFiles,
        remoteCommands: {},
        prNumber: caseData.prNumber || 1,
        repositoryFullName: caseData.repositoryFullName || 'eval/repo',
        // build-orchestrator-input.ts:107-108 sends en-US when the team set none.
        languageResultPrompt: caseData.languageResultPrompt || 'en-US',
        memoryRules: parseMaybeJson(caseData.memoryRules) || [],
        traceDecisions: parseMaybeJson(caseData.traceDecisions) || undefined,
        // Coding-agent instructions (CLAUDE.md, AGENTS.md, ...) collected for
        // the case, as the agent stage would pass them. Absent = setting off.
        repoInstructions: parseMaybeJson(caseData.repoInstructions) || undefined,
        v2PromptOverrides: parseMaybeJson(caseData.v2PromptOverrides),
        generationMain: caseData.generationMain,
        prTitle: caseData.prTitle,
        prBody: caseData.prBody,
        reviewMode,
        // The orchestrator's step budget for the generalist, from the PR's file
        // count (review-orchestrator.service.ts:196-205, :335-370): 20 in normal
        // mode plus half a step per file past eight, up to 100. The datasets pin
        // 12, which production never runs with. RECALL_MAX_STEPS overrides it
        // for an experiment.
        maxSteps:
            Number(process.env.RECALL_MAX_STEPS) ||
            ReviewOrchestratorService.prototype.getMaxStepsForAgent.call(null, 'generalist', reviewMode, prFiles.length),
        // Production asks the generalist for every category the team left on
        // (review-orchestrator.service.ts:109-113, from reviewOptions, all on
        // by default: agent-review.stage.ts:480-484), which is also the
        // generalist's own default (generalist-agent.provider.ts:59-63). The
        // datasets pin ["bug"]; that pin is no longer the default.
        // RECALL_CATEGORIES=bug,security narrows it for an experiment.
        requestedCategories: process.env.RECALL_CATEGORIES
            ? process.env.RECALL_CATEGORIES.split(',').map((c) => c.trim()).filter(Boolean)
            : undefined,
        callGraph: parseMaybeJson(caseData.callGraph),
        // No callGraphJson: production never sets one (the pipeline context's
        // callGraphJson has no writer in libs/ or apps/; only the scorer reads
        // it, base-code-review-agent.provider.ts:367-371), so its file scores
        // rank by diff size. The datasets' callGraphJson is not used.
        baseBranch: caseData.baseBranch || 'main',
        // A batch carries what runChunkedReview copies from its parent input:
        // the parent's tiers, its runtime name, its place (batch-runner.ts:113-120).
        ...(batch
            ? {
                  fileTiers: batch.fileTiers,
                  agentRuntimeName: batch.runtimeName,
                  batchIndex: batch.index,
                  batchTotal: batch.total,
                  recursionDepth: batch.depth,
              }
            : {}),
    };

    // execute(): the model, its window and the adaptive profile (:194-245).
    const { byokConfig, main } = await resolveReviewAgentModel(input, permissionService);
    const contextWindow = resolveContextWindow({ byokMaxInputTokens: main.maxInputTokens, modelName: main.modelName });
    const adaptiveProfile = resolveAdaptiveProfile(contextWindow);
    // build-orchestrator-input.ts:153-154: the stage's profile skips the heavy
    // passes on a small window.
    input = { ...input, adaptiveProfile, skipHeavyPasses: adaptiveProfile.skipHeavyPasses || undefined };
    planner.assertContextWindowFitsOverhead({ input, contextWindow, modelName: main.modelName });
    const promptBudget = Math.floor(contextWindow * planner.PROMPT_BUDGET_RATIO);

    // Adaptive fit: long diffs cut to the profile's cap (:266-300).
    if (adaptiveProfile.maxDiffChars && input.changedFiles?.length) {
        const cap = adaptiveProfile.maxDiffChars;
        input = {
            ...input,
            changedFiles: input.changedFiles.map((f) => {
                const diff = f.patchWithLinesStr ?? f.patch ?? '';
                if (diff.length <= cap) return f;
                const cut = `${diff.slice(0, cap)}\n... (diff truncated to ${cap} chars by adaptive-fit; readFile for the rest)`;
                return f.patchWithLinesStr ? { ...f, patchWithLinesStr: cut } : { ...f, patch: cut };
            }),
        };
    }

    // Large PR: drop low-signal files, then tier what is left (:302-416).
    let estimatedPromptTokens = planner.estimatePromptTokens(input);
    let lowSignalDropped = 0;
    const shouldFireFilter =
        input.changedFiles.length > 1 &&
        (adaptiveProfile.lowSignalFilterUnconditional ||
            (estimatedPromptTokens > promptBudget && input.reviewMode !== 'deep'));
    if (shouldFireFilter) {
        const filtered = planner.applyLargePrAggressiveFilter(input.changedFiles);
        lowSignalDropped = input.changedFiles.length - filtered.length;
        if (lowSignalDropped > 0) input = { ...input, changedFiles: filtered };
        const fileTiers = assignFileTiers(computeFileScores(input.changedFiles, input.callGraphJson));
        if (adaptiveProfile.allOptional) {
            for (const filename of fileTiers.keys()) fileTiers.set(filename, 'optional');
        }
        input = { ...input, fileTiers };
        estimatedPromptTokens = planner.estimatePromptTokens(input);
    }

    // Still over budget: production splits the PR into batches, each reviewed
    // by its own execute() (:420-505 → runChunkedReview).
    let chunks = null;
    if (estimatedPromptTokens > promptBudget && input.changedFiles.length > 1) {
        const overheadTokens = planner.estimateNonDiffOverheadTokens(input);
        const chunkDiffBudget = Math.max(promptBudget - overheadTokens, Math.floor(contextWindow * 0.3));
        const preview = planner.chunkFilesByTokenBudget(input.changedFiles, chunkDiffBudget);
        if (!(preview.length === 1 && preview[0].length === input.changedFiles.length)) chunks = preview;
    }

    return {
        provider,
        input,
        byokConfig,
        main,
        contextWindow,
        estimatedPromptTokens,
        lowSignalDropped,
        chunks,
        systemPrompt: chunks ? null : provider.buildSystemPrompt(input),
        userPrompt: chunks ? null : provider.buildUserPrompt(input),
    };
}

// The loop parameters execute() builds from that input (:563-640).
function productionLoopInput(run) {
    const { input, main, provider } = run;
    const { listsRepoInstructions } = require(
        path.join(__dirname, '../../libs/code-review/infrastructure/agents/prompts/prompt-builder.ts'),
    );
    return {
        systemPrompt: run.systemPrompt,
        userPrompt: run.userPrompt,
        agentName: input.agentRuntimeName || provider.getIdentity().name,
        usageRunName: `code-review-${provider.getCategoryLabel()}`,
        telemetryMetadata: {
            organizationId: input.organizationAndTeamData?.organizationId,
            teamId: input.organizationAndTeamData?.teamId,
            pullRequestId: input.prNumber,
            provider: main.modelName,
        },
        changedFiles: input.changedFiles,
        prNumber: input.prNumber,
        repositoryFullName: input.repositoryFullName,
        baseBranch: input.baseBranch,
        callGraph: input.callGraph,
        fileTiers: input.fileTiers,
        reviewMode: input.reviewMode,
        maxSteps: input.maxSteps,
        skipHeavyPasses: input.skipHeavyPasses,
        skipSynthesisRescue: input.skipSynthesisRescue,
        // The verifier judges repo_instruction findings against these; the
        // finder reads them through readRepoInstruction when its prompt lists
        // them, the same decision the provider makes.
        repoInstructions: input.repoInstructions,
        listsRepoInstructions: listsRepoInstructions(
            input.repoInstructions,
            provider.getAllowedSuggestionLabels(input),
        ),
        // heavy força as passadas de resample (mais recall via reamostragem).
        // É EIXO DE REGIME: comparar heavy com normal é o mesmo erro que
        // comparar assinatura com API.
        ...(process.env.RECALL_HEAVY === '1' ? { heavy: true } : {}),
        contextWindowTokens: run.contextWindow,
        reasoningEffort: main.reasoningEffort,
        reasoningConfigOverride: main.reasoningConfigOverride,
        byokProvider: main.byokProvider,
        modelName: main.modelName,
        byokRole: main.role,
        openrouterProviderOrder: main.openrouterProviderOrder,
        openrouterAllowFallbacks: main.openrouterAllowFallbacks,
    };
}

// The grep, read and listDir production's local sandbox (the self-hosted path)
// hands the agent, over a prepared worktree: the same output and the same
// errors for those three. Built by the sandbox's own method, so they cannot
// drift from production. exec is left out for now, as in the replay, so the
// exec-gated tools (checkTypes, findNearestProjectFile, findFile's fd/find
// path) are not registered: a smaller tool set than production's, recorded as
// `sandboxExec` in each row. Wrapped only to count calls for the fidelity
// metric: a real answer, empty or not, is never an unserved call.
function sandboxCommands(repoDir) {
    const { LocalSandboxService } = require(
        path.join(
            __dirname,
            '../../libs/sandbox/infrastructure/providers/local-sandbox.service.ts',
        ),
    );
    // buildRemoteCommands is private in TypeScript; it reads no instance
    // state, and the constructor ignores its ConfigService.
    const inner = new LocalSandboxService(undefined).buildRemoteCommands(
        repoDir,
    );
    const commands = { calls: [], unexpectedCalls: [] };
    for (const name of ['grep', 'read', 'listDir']) {
        const fn = inner[name];
        const kind = name === 'read' ? 'readFile' : name;
        commands[name] = (...args) => {
            commands.calls.push({ kind, actual: args, matched: true });
            return fn(...args);
        };
    }
    return commands;
}

// The files of an inline repository, written to a fresh directory. Same
// handle shape as prepareRepo's; there is no commit to name.
function writeInlineRepo(files) {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eval-inline-repo-'));
    // The caller only cleans a handle it got back: a throw here removes the
    // directory itself.
    try {
        for (const [file, content] of Object.entries(files || {})) {
            const target = path.join(dir, file);
            if (!target.startsWith(dir + path.sep)) throw new Error(`repoFiles path escapes the repository: ${file}`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, String(content));
        }
    } catch (error) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw error;
    }
    return { dir, sha: null, cleanup: async () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function serializeResult(caseId, agentResult, remoteCommands, repoHandle, production) {
    return {
        caseId,
        reasoning: agentResult.findings?.reasoning || '',
        findings: agentResult.findings?.suggestions || [],
        trace: {
            steps: agentResult.steps,
            finishReason: agentResult.finishReason,
            source: agentResult.source,
            usage: agentResult.usage,
            coverage: agentResult.coverage,
            anomalies: agentResult.anomalies,
            verification: agentResult.verification,
            toolCalls: (agentResult.toolCalls || []).map((call) => ({
                tool: call.toolName || call.tool,
                args: call.args || {},
            })),
            unexpectedToolCalls: remoteCommands.unexpectedCalls,
            // Total calls the replay actually fielded (served + unserved) — the
            // correct denominator for the replay hit-rate. The agent's toolCalls
            // array undercounts (no retries/internal reads), so don't use it.
            replayCalls: Array.isArray(remoteCommands.calls)
                ? remoteCommands.calls.length
                : null,
            repoPrepared: !!repoHandle,
            headSha: repoHandle ? repoHandle.sha : null,
            // false: the exec-gated tools were not registered for this case.
            sandboxExec: typeof remoteCommands.exec === 'function',
            // How production ran this review: its model route and model, the
            // window, the files it got, and each batch (one unless split).
            production: production || null,
        },
    };
}

function agentRunFailure(agentResult) {
    if (!agentResult || typeof agentResult !== 'object') {
        return 'agent loop returned no result';
    }

    const finishReason = agentResult.finishReason || 'unknown';
    const usage = agentResult.usage || {};
    const totalTokens = Number(usage.totalTokens || 0);
    const steps = Number(agentResult.steps || 0);
    const trace = Array.isArray(agentResult.debugTrace)
        ? agentResult.debugTrace
        : [];
    const errorEvent = [...trace]
        .reverse()
        .find((event) => event && event.kind === 'error');
    const errorMessage =
        errorEvent?.detail && typeof errorEvent.detail.message === 'string'
            ? errorEvent.detail.message
            : '';

    if (finishReason === 'error') {
        return errorMessage
            ? `agent loop finished with error: ${errorMessage}`
            : 'agent loop finished with error';
    }

    if (steps === 0 && totalTokens === 0) {
        return 'agent loop produced zero steps and zero tokens';
    }

    return null;
}

// execute() → runChunkedReview → execute() is capped here
// (base-code-review-agent.provider.ts:52-60): a batch that would split again
// fails, as its nested batches would.
const MAX_RECURSION_DEPTH = 2;

// One review of the PR as production runs it: one loop, or one per batch when
// production splits the PR (runChunkedReview, batch-runner.ts:40-210). A failed
// batch is left out like production leaves it out; only every batch failing
// fails the review (:189-209).
async function runProduction(caseData, permissionService, run, remoteCommands, runAgentLoop, depth = 0) {
    if (!run.chunks) {
        const result = await runAgentLoop(productionLoopInput(run), {
            remoteCommands,
            byokConfig: run.byokConfig,
            byokErrorReporter: undefined,
        });
        const failure = agentRunFailure(result);
        if (failure) {
            throw new Error(
                `${failure} (finishReason=${result?.finishReason || 'unknown'}, ` +
                    `steps=${result?.steps ?? 'n/a'}, ` +
                    `tokens=${result?.usage?.totalTokens ?? 'n/a'})`,
            );
        }
        return { ...result, batches: [batchTrace(run, result)] };
    }
    if (depth + 1 >= MAX_RECURSION_DEPTH) throw new Error('AGENT_RECURSION_LIMIT_EXCEEDED');
    const total = run.chunks.length;
    const results = [];
    const errors = [];
    for (let i = 0; i < total; i++) {
        // A batch that cannot be built is left out like one that fails to run
        // (batch-runner.ts): the other batches' findings stay.
        try {
            // eslint-disable-next-line no-await-in-loop
            const batchRun = await buildProductionRun(caseData, permissionService, {
                changedFiles: run.chunks[i],
                fileTiers: run.input.fileTiers,
                runtimeName: `${run.provider.getIdentity().name} batch ${i + 1}/${total}`,
                index: i + 1,
                total,
                depth: depth + 1,
            });
            // eslint-disable-next-line no-await-in-loop
            results.push(await runProduction(caseData, permissionService, batchRun, remoteCommands, runAgentLoop, depth + 1));
        } catch (error) {
            errors.push(error);
        }
    }
    if (!results.length) throw errors[0];
    const merged = mergeResults(results);
    return { ...merged, failedBatches: errors.map((e) => String(e?.message || e).slice(0, 200)) };
}

function batchTrace(run, result) {
    return {
        files: run.input.changedFiles.length,
        lowSignalDropped: run.lowSignalDropped,
        tiered: !!run.input.fileTiers,
        estimatedPromptTokens: run.estimatedPromptTokens,
        maxSteps: run.input.maxSteps,
        steps: result?.steps ?? null,
    };
}

// The batches' loop results as one, for the row: findings and calls in batch
// order, counts summed.
function mergeResults(results) {
    if (results.length === 1) return results[0];
    const sum = (key) => results.reduce((n, r) => n + Number(r.usage?.[key] || 0), 0);
    return {
        findings: {
            reasoning: results.map((r) => r.findings?.reasoning || '').filter(Boolean).join('\n\n'),
            suggestions: results.flatMap((r) => r.findings?.suggestions || []),
        },
        steps: results.reduce((n, r) => n + Number(r.steps || 0), 0),
        finishReason: results[results.length - 1].finishReason,
        source: results.map((r) => r.source).join(','),
        usage: {
            inputTokens: sum('inputTokens'),
            outputTokens: sum('outputTokens'),
            totalTokens: sum('totalTokens'),
            reasoningTokens: sum('reasoningTokens'),
            cacheReadTokens: sum('cacheReadTokens'),
            cacheWriteTokens: sum('cacheWriteTokens'),
        },
        coverage: results.map((r) => r.coverage),
        anomalies: results.map((r) => r.anomalies),
        verification: results.map((r) => r.verification),
        toolCalls: results.flatMap((r) => r.toolCalls || []),
        batches: results.flatMap((r) => r.batches || []),
    };
}

function writeResultArtifact(filename, payload) {
    try {
        fs.writeFileSync(
            path.join(__dirname, 'results', filename),
            JSON.stringify(payload, null, 2),
        );
    } catch {}
}

class InvestigationAgentProvider {
    constructor(options) {
        this.config = options.config || {};
        this.providerId =
            this.config.label ||
            `${this.config.provider || 'google'}:${this.config.model || 'unknown'}`;
    }

    id() {
        return this.providerId;
    }

    async callApi(prompt, context, options) {
        let stage = 'parse-prompt';
        // Declared outside the try so the finally below can always release it.
        let repoHandle = null;
        try {
            const rawPrompt =
                typeof prompt === 'string'
                    ? prompt
                    : prompt && typeof prompt === 'object' && 'prompt' in prompt
                      ? prompt.prompt
                      : prompt;
            const caseData = parseMaybeJson(rawPrompt);
            if (!caseData || typeof caseData !== 'object') {
                throw new Error(
                    `Expected prompt loader to provide a JSON object, got ${JSON.stringify(
                        summarizeInput(caseData),
                    )}`,
                );
            }

            stage = 'load-agent-loop';
            // The legacy runAgentLoop (agent-loop.ts) was deleted in the
            // agent-harness refactor. runAgentLoopViaCore is the drop-in seam:
            // same (input, secrets) signature, threads secrets.remoteCommands
            // into buildFinderToolRegistry for deterministic tool replay, and
            // runs the finder+verify on the new harness.
            const { runAgentLoopViaCore: runAgentLoop } = require(
                path.join(
                    __dirname,
                    '../../libs/code-review/infrastructure/agents/core/core-agent-loop.adapter.ts',
                ),
            );

            stage = 'resolve-model';
            const route = resolveRoute(this.config);
            const permissionService = evalPermissionService(route.storedConfig);
            stage = 'build-prompts';
            const run = await buildProductionRun(caseData, permissionService);
            stage = 'build-replay-commands';
            // RECALL_REAL_REPO=1: answer the tools from a git worktree at the
            // PR's head instead of replaying recorded tool calls. The replay
            // only answers calls captured when the dataset was built; any other
            // call gets an empty answer the real repository would not give.
            // Falls back to replay when the commit can't be fetched;
            // `repoPrepared` in the trace says which one ran.
            let remoteCommands;
            // A case written for an eval can carry its repository inline
            // (`repoFiles`: every file at the PR's head): the tools then answer
            // from it through the same local sandbox, never from a replay.
            if (caseData.repoFiles) {
                repoHandle = writeInlineRepo(parseMaybeJson(caseData.repoFiles));
                remoteCommands = sandboxCommands(repoHandle.dir);
            } else if (process.env.RECALL_REAL_REPO === '1') {
                const { prepareRepo } = require('./prepare-repo');
                repoHandle = await prepareRepo(caseData, caseData.caseId);
                if (repoHandle) remoteCommands = sandboxCommands(repoHandle.dir);
            }
            if (!remoteCommands) {
                remoteCommands = new ReplayRemoteCommands(
                    parseMaybeJson(caseData.toolReplay) || {},
                );
            }

            stage = 'run-agent-loop';
            // runAgentLoop(input, secrets): `secrets` was split out of `input` so
            // span I/O never records keys/services. The deterministic tool replay
            // (remoteCommands) lives in `secrets` now — passing it in `input` (the
            // old single-arg shape) left the agent tool-less and crashed on
            // `secrets.byokErrorReporter`.
            const agentResult = await runProduction(caseData, permissionService, run, remoteCommands, runAgentLoop);

            stage = 'serialize-result';
            const output = serializeResult(
                caseData.caseId || 'unknown-case',
                agentResult,
                remoteCommands,
                repoHandle,
                {
                    route: route.route,
                    model: run.main.modelName,
                    reasoningEffort: run.main.reasoningEffort ?? null,
                    contextWindowTokens: run.contextWindow,
                    prFiles: normalizeChangedFiles(parseMaybeJson(caseData.changedFilesFull) || parseMaybeJson(caseData.changedFiles)).length,
                    fullDiff: !!parseMaybeJson(caseData.changedFilesFull),
                    categories: run.provider.getAllowedSuggestionLabels(run.input),
                    batches: agentResult.batches || [],
                    failedBatches: agentResult.failedBatches || [],
                },
            );
            writeResultArtifact('last-output.json', output);

            return {
                output: JSON.stringify(output),
                tokenUsage: {
                    prompt: agentResult.usage.inputTokens,
                    completion: agentResult.usage.outputTokens,
                    total: agentResult.usage.totalTokens,
                },
            };
        } catch (error) {
            const payload = {
                error:
                    error instanceof Error ? error.message : String(error),
                metadata: {
                    stage,
                    providerId: this.providerId,
                    prompt: summarizeInput(prompt),
                    context: summarizeInput(context),
                    options: summarizeInput(options),
                    stack:
                        error instanceof Error
                            ? error.stack?.split('\n').slice(0, 20).join('\n')
                            : undefined,
                },
            };
            try {
                fs.writeFileSync(
                    path.join(__dirname, 'results', 'last-error.json'),
                    JSON.stringify(payload, null, 2),
                );
            } catch {}

            return {
                ...payload,
            };
        } finally {
            // Always drop the worktree: cases run in parallel and each one adds
            // a full checkout to disk.
            if (repoHandle) {
                try {
                    await repoHandle.cleanup();
                } catch {}
            }
        }
    }
}

module.exports = InvestigationAgentProvider;
// For the specs: how a case reaches production's loop.
module.exports.internals = { resolveRoute, evalPermissionService, buildProductionRun, productionLoopInput, mergeResults, NotAProductionRoute };
