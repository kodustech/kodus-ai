require('ts-node/register/transpile-only');

require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const { resolveContextWindow } = require(
    path.join(__dirname, '../../libs/llm/model-context-window.ts'),
);

const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });

// Langfuse, registered AFTER dotenv and never before it. Two ordering traps
// live here: `shouldTrace()` reads LANGFUSE_PUBLIC_KEY/SECRET_KEY, which do not
// exist until the lines above run — registering earlier silently produced a
// null span processor and every span was dropped. And `.env.local` loads with
// `override: true`, so any default set before it is replaced by whatever the
// file holds; the environment name has to be decided after both files, not in
// front of them.
process.env.LANGFUSE_ENVIRONMENT =
    process.env.LANGFUSE_ENVIRONMENT || 'benchmark';
try {
    const lf = require(path.join(__dirname, '../../libs/core/log/langfuse.ts'));
    lf.registerLangfuseStandalone();
    // Both halves are required and the second is easy to miss: the standalone
    // registration only installs the span processor on a tracer provider.
    // AI SDK 7 emits nothing from `telemetry`/`experimental_telemetry` until a
    // telemetry integration is registered in its own callback registry — see
    // registerLangfuseAiSdkTelemetry's own doc.
    lf.registerLangfuseAiSdkTelemetry();
    // The port production registers from NestJS — without it agent-loop-call
    // takes the no-span branch and nothing is ever created to export.
    require('./eval-observability').registerEvalObservability();
    const on =
        process.env.LANGFUSE_TRACING === 'true' &&
        !!process.env.LANGFUSE_PUBLIC_KEY &&
        !!process.env.LANGFUSE_SECRET_KEY;
    console.log(
        on
            ? `[langfuse] tracing ON · env=${process.env.LANGFUSE_ENVIRONMENT} · ${process.env.LANGFUSE_BASE_URL || '(default)'}`
            : `[langfuse] tracing OFF · TRACING=${process.env.LANGFUSE_TRACING} PUBLIC_KEY=${process.env.LANGFUSE_PUBLIC_KEY ? 'set' : 'MISSING'} SECRET_KEY=${process.env.LANGFUSE_SECRET_KEY ? 'set' : 'MISSING'}`,
    );
} catch (err) {
    console.warn(`[langfuse] falhou ao registrar: ${String(err).slice(0, 160)}`);
}

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

// Count changed lines from the patch. The datasets carry only filename+patch,
// but computeFileScores reads additions/deletions — without them every file
// scores an identical diffMultiplier and the priority ranking collapses to
// insertion order. Production gets these from the VCS; deriving them here keeps
// the eval's tiering comparable instead of degenerate.
function countPatchLines(patch) {
    let additions = 0;
    let deletions = 0;
    for (const line of String(patch || '').split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) additions++;
        else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
    }
    return { additions, deletions };
}

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

function normalizeRequestedCategories(value) {
    const parsed = parseMaybeJson(value);

    if (Array.isArray(parsed)) {
        return parsed.filter(Boolean).map(String);
    }

    if (typeof parsed === 'string' && parsed.trim()) {
        return [parsed.trim()];
    }

    return undefined;
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

function buildOpenRouterProviderRouting(config) {
    const providerOrder = Array.isArray(config.providerOrder)
        ? config.providerOrder.filter(Boolean)
        : [];

    if (
        providerOrder.length === 0 &&
        typeof config.allowFallbacks !== 'boolean' &&
        typeof config.requireParameters !== 'boolean'
    ) {
        return null;
    }

    return {
        ...(providerOrder.length > 0 ? { order: providerOrder } : {}),
        ...(typeof config.allowFallbacks === 'boolean'
            ? { allow_fallbacks: config.allowFallbacks }
            : {}),
        ...(typeof config.requireParameters === 'boolean'
            ? { require_parameters: config.requireParameters }
            : {}),
    };
}

function buildOpenAICompatibleConfig(config, apiKey, defaultName) {
    const openRouterProviderRouting =
        config.provider === 'openrouter'
            ? buildOpenRouterProviderRouting(config)
            : null;

    return {
        name: config.providerName || defaultName,
        apiKey,
        baseURL:
            config.baseURL ||
            (config.provider === 'openrouter'
                ? 'https://openrouter.ai/api/v1'
                : undefined),
        ...(config.headers ? { headers: config.headers } : {}),
        ...(config.queryParams ? { queryParams: config.queryParams } : {}),
        ...(openRouterProviderRouting
            ? {
                  transformRequestBody: (body) => ({
                      ...body,
                      provider: {
                          ...(body.provider || {}),
                          ...openRouterProviderRouting,
                      },
                  }),
              }
            : {}),
    };
}


/**
 * Injeta esforco de raciocinio explicito nas chamadas do modelo.
 *
 * POR QUE: o caminho self-hosted monta o modelo sem providerOptions, e o eval
 * nunca seta config.main.reasoningEffort — entao TODO modelo roda no default do
 * fornecedor. Isso nao e neutro: medimos gemini-3.7-flash gastando 5.2k tokens
 * de saida por caso, contra ~107k que o mesmo modelo gasta em bench publico com
 * thinking alto. O default e um eixo experimental, nao uma constante, e comparar
 * modelos com defaults diferentes compara configuracoes, nao capacidades.
 *
 * Ativa com RECALL_REASONING_EFFORT=low|medium|high. Sem a env, nada muda.
 * O valor escolhido vai para o artefato via runMetaOf(), senao o numero fica
 * sem regime declarado.
 */
function withReasoningEffort(model, modelId) {
    const effort = process.env.RECALL_REASONING_EFFORT;
    if (!effort) return model;

    const { buildReasoningProviderOptions } = require('../../libs/llm/reasoning-options.ts');
    // provider derivado do id: o mapeamento nativo difere por fornecedor
    // (thinkingLevel no Gemini 3+, reasoningEffort na OpenAI, thinking.type nos
    // OpenAI-compativeis).
    // valores do enum BYOKProvider (byokProvider.service.ts), nao os nomes
    const provider = /^gemini/i.test(modelId)
        ? 'google_gemini'
        : /^claude/i.test(modelId)
          ? 'anthropic'
          : /^gpt|^o\d/i.test(modelId)
            ? 'openai'
            : 'openai_compatible';
    const injected = buildReasoningProviderOptions(provider, effort, modelId);
    if (!injected || !Object.keys(injected).length) {
        console.warn(`[reasoning] ${modelId}: nenhuma opcao mapeada para effort=${effort}`);
        return model;
    }
    console.log(`[reasoning] ${modelId} effort=${effort} -> ${JSON.stringify(injected)}`);

    const merge = (options) => ({
        ...options,
        providerOptions: { ...(options?.providerOptions || {}), ...injected },
    });
    return new Proxy(model, {
        get(target, prop, receiver) {
            if (prop === 'doGenerate' || prop === 'doStream') {
                return async (options) => target[prop](merge(options));
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}

/**
 * Wrap a model so the run can PROVE which one served it.
 *
 * The eval used to build a model and hand it over in `input.model`, which the
 * loop adapter never read — the run silently fell back to the env default while
 * the artifact still carried the requested model's name. Every number was
 * labelled with a model that may not have run. This counter makes that failure
 * loud: zero calls means the model never served the review, and the case fails
 * instead of publishing a mislabelled score.
 */
function withCallCounter(model, label) {
    const stats = { label, modelId: model?.modelId ?? label, calls: 0 };
    const proxy = new Proxy(model, {
        get(target, prop, receiver) {
            if (prop === '__evalStats') return stats;
            if (prop === 'doGenerate' || prop === 'doStream') {
                return async (options) => {
                    stats.calls++;
                    return target[prop](options);
                };
            }
            return Reflect.get(target, prop, receiver);
        },
    });
    return proxy;
}

async function createModel(config) {
    if (config.provider === 'tier0') {
        const modelId = process.env.RECALL_MODEL || config.model;
        const { applyModelEnv, TIER0 } = require('../shared/tier0-models');

        // Assinatura: nao passa por buildModelFromSlot (que espera chave de API).
        // Fala com chatgpt.com/backend-api via token OAuth do Codex; o wrapper
        // resolve o streaming-only + store:false.
        const spec = TIER0[modelId];
        if (spec && spec.provider === 'codex_subscription') {
            const { buildCodexSubscriptionModel } = require('../../libs/llm/codex-subscription-model.ts');
            return withCallCounter(
                buildCodexSubscriptionModel(spec.codexModel || modelId),
                spec.codexModel || modelId,
            );
        }

        const { buildEvalModel } = require('../shared/build-model');
        applyModelEnv(modelId);
        return withCallCounter(
            withReasoningEffort(buildEvalModel({}), modelId),
            modelId,
        );
    }

    // Env overrides so ANY model runs from one yaml (no per-provider config):
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

    if (!model) {
        throw new Error('Missing provider config.model');
    }
    if (!apiKey) {
        throw new Error(`Missing API key for ${provider} in ${apiKeyEnv}`);
    }

    if (provider === 'google') {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        return createGoogleGenerativeAI({ apiKey })(model);
    }

    if (provider === 'anthropic') {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        return createAnthropic({
            apiKey,
            ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        })(model);
    }

    if (provider === 'openai') {
        const { createOpenAI } = await import('@ai-sdk/openai');
        return createOpenAI({
            apiKey,
            ...(config.headers ? { headers: config.headers } : {}),
            ...(config.baseURL ? { baseURL: config.baseURL } : {}),
        })(model);
    }

    if (provider === 'openrouter' || provider === 'openai-compatible') {
        const { createOpenAICompatible } = await import(
            '@ai-sdk/openai-compatible'
        );
        return createOpenAICompatible(
            buildOpenAICompatibleConfig(
                config,
                apiKey,
                provider === 'openrouter' ? 'openrouter' : 'openai-compatible',
            ),
        )(model);
    }

    throw new Error(`Unsupported provider: ${provider}`);
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

function buildCurrentPrompts(caseData) {
    const { GeneralistAgentProvider } = require(
        path.join(
            __dirname,
            '../../libs/code-review/infrastructure/agents/providers/generalist-agent.provider.ts',
        ),
    );

    const provider = new GeneralistAgentProvider({}, {}, {});
    const input = {
        organizationAndTeamData: {
            organizationId: 'eval-org',
            teamId: 'eval-team',
        },
        // The PR's COMPLETE diff, rendered exactly as fetch-changed-files.stage.ts
        // renders it in production (handlePatchDeletions ->
        // convertToUnifiedDiffWithLineNumbers). `changedFiles` is the corpus's
        // original field and holds at most 6 files with tests filtered out —
        // across the light set, 138 files against the 757 the PRs actually
        // touch, and nothing recorded the omission. Measuring on that view
        // describes a review the product never performs.
        //
        // Falls back to the old field only for a case with no materialized
        // diff (see materialize-full-diff.js), so an un-regenerated dataset
        // still runs instead of silently reviewing nothing.
        changedFiles: normalizeChangedFiles(
            parseMaybeJson(caseData.changedFilesFull) ||
                parseMaybeJson(caseData.changedFiles),
        ),
        remoteCommands: {},
        prNumber: caseData.prNumber || 1,
        repositoryFullName: caseData.repositoryFullName || 'eval/repo',
        languageResultPrompt: caseData.languageResultPrompt || '',
        memoryRules: parseMaybeJson(caseData.memoryRules) || [],
        traceDecisions: parseMaybeJson(caseData.traceDecisions) || undefined,
        v2PromptOverrides: parseMaybeJson(caseData.v2PromptOverrides),
        generationMain: caseData.generationMain,
        prTitle: caseData.prTitle,
        prBody: caseData.prBody,
        reviewMode: caseData.reviewMode || 'normal',
        // RECALL_MAX_STEPS: the cap is never reached (finishReason is `stopped`
        // in 30/30, median 5 steps of 12) but BudgetPolicy derives the
        // synthesis-pressure note FROM it: encourageFrom = maxSteps - 9, so at
        // 12 the agent is told "avoid new reads" from step 3 onward. Raising
        // the cap is how you move that note later.
        maxSteps: Number(process.env.RECALL_MAX_STEPS) || caseData.maxSteps || 12,
        // RECALL_CATEGORIES: the datasets pin this to ["bug"] in 51 of 53 cases,
        // while production defaults to bug+security+performance. That gap is
        // not cosmetic: prompt-builder renders "run an explicit pass for each
        // enabled category" and "note at least one concrete hypothesis you
        // tested for each", so with a single category that whole sweep
        // collapses into one pass. Every number in this investigation was
        // measured on a narrower config than the product ships.
        requestedCategories: process.env.RECALL_CATEGORIES
            ? process.env.RECALL_CATEGORIES.split(',').map((c) => c.trim()).filter(Boolean)
            : normalizeRequestedCategories(caseData.requestedCategories),
        callGraph: parseMaybeJson(caseData.callGraph),
        callGraphJson: parseMaybeJson(caseData.callGraphJson),
        baseBranch: caseData.baseBranch || 'main',
        // Production resolves this in agent-review.stage.ts and hands it to the
        // loop, which builds a ContextWindowCompressor from it. The eval never
        // passed it, so the compressor was absent — harmless while the corpus
        // held six files and a 20k prompt, and decisive now that the complete
        // diff puts some PRs over 300k. Without it the window is managed by the
        // provider truncating, not by the harness compacting.
        contextWindowTokens: resolveContextWindow({
            modelName: process.env.RECALL_MODEL || '',
        }),
    };

    // Priority tiering, mirroring what the provider's execute() does in
    // production. The eval bypasses execute() (it calls the prompt builders
    // directly), so without this the loop ran with fileTiers=undefined and the
    // completion gate never saw a critical target.
    const fileTiers = assignEvalFileTiers(input);
    if (fileTiers) input.fileTiers = fileTiers;

    return {
        input,
        systemPrompt: provider.buildSystemPrompt(input),
        userPrompt: provider.buildUserPrompt(input),
    };
}

function assignEvalFileTiers(input) {
    if ((input.changedFiles || []).length < 2) return undefined;
    const { computeFileScores, assignFileTiers } = require(
        path.join(
            __dirname,
            '../../libs/code-review/infrastructure/agents/engine/file-priority-scorer.ts',
        ),
    );
    const scores = computeFileScores(input.changedFiles, input.callGraphJson);
    return assignFileTiers(scores);
}

function serializeResult(caseId, agentResult, remoteCommands, input, modelStats, dedupTrace, preFilterCandidates, pipeline) {
    return {
        caseId,
        reasoning: agentResult.findings?.reasoning || '',
        // Post-dedup — this IS what gets judged (agent-review.stage.ts's real
        // order: generate -> dedup -> rest of pipeline). See dedupTrace.before
        // for the raw pre-dedup count.
        findings: agentResult.findings?.suggestions || [],
        trace: {
            steps: agentResult.steps,
            finishReason: agentResult.finishReason,
            source: agentResult.source,
            usage: agentResult.usage,
            coverage: agentResult.coverage,
            anomalies: agentResult.anomalies,
            verification: agentResult.verification,
            recallPasses: agentResult.recallPasses,
            shardPlan: agentResult.shardPlan || null,
            pipeline: pipeline || null,
            scoutFlags: agentResult.scoutFlags,
            dedup: dedupTrace || null,
            // The candidate set as it stood before dedup/reducer, each item
            // tagged with the pass that produced it (`producedBy`). This is
            // what makes offline filter A/B possible.
            preFilterCandidates: (preFilterCandidates || []).map((f) => ({
                ...f,
                producedBy: f.producedBy || 'generalist-base',
            })),
            // Which files the tiering picked, and whether the call graph had
            // anything to say. A run where every PR fell back to diff-size is a
            // different experiment from one where blast radius actually ranked.
            fileTiers: input?.fileTiers
                ? Object.fromEntries(input.fileTiers)
                : null,
            hasCallGraph: !!input?.callGraphJson?.edges?.length,
            // Proof of WHICH model served this case, counted at the transport.
            modelServed: modelStats || null,
            reasoningEffort: process.env.RECALL_REASONING_EFFORT || null,
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

            stage = 'create-model';
            const model = await createModel(this.config);

            stage = 'build-replay-commands';
            // RECALL_REAL_REPO=1: search a real git worktree (base commit +
            // this PR's diff) instead of replaying recorded tool calls. The
            // replay can only answer calls captured when the dataset was built,
            // which (a) left ~15% of calls unserved in recent runs and (b) makes
            // selector-style passes untestable by construction — a selector
            // searches for code the diff does NOT contain. Falls back to replay
            // whenever the repo or the base commit isn't available locally, so a
            // missing clone degrades the run instead of failing it.
            //
            // Runs BEFORE the prompts are built: the call graph below is part of
            // the generalist's user prompt, and it needs the worktree.
            let remoteCommands;
            if (process.env.RECALL_REAL_REPO === '1') {
                const { prepareRepo } = require('./prepare-repo');
                const { LocalRepoCommands } = require('./local-repo-commands');
                repoHandle = await prepareRepo(caseData, caseData.caseId);
                if (repoHandle) remoteCommands = new LocalRepoCommands(repoHandle.dir);
            }
            if (!remoteCommands) {
                remoteCommands = new ReplayRemoteCommands(
                    parseMaybeJson(caseData.toolReplay) || {},
                );
            }

            // RECALL_CALL_GRAPH=1: give the generalist the <CallGraph> blob
            // production injects. No dataset has ever defined `vars.callGraph`,
            // so this section rendered EMPTY in every run we have measured — on
            // every model, including the big ones the blob is gated for.
            stage = 'build-call-graph';
            let callGraphCtx = null;
            if (process.env.RECALL_CALL_GRAPH === '1' && repoHandle) {
                const { buildPrCallGraph } = require('./build-pr-callgraph');
                const cg = await buildPrCallGraph(
                    caseData,
                    repoHandle.dir,
                    caseData.caseId,
                    (m) => console.log(m),
                );
                if (cg) {
                    caseData.callGraph = cg.xml;
                    callGraphCtx = cg.json;
                }
            }

            stage = 'build-prompts';
            const { input, systemPrompt, userPrompt } =
                buildCurrentPrompts(caseData);

            // Everything the PR debugger needs to say OK / NOT OK about the
            // steps BEFORE the model was called. Inferring these after the fact
            // is guesswork: whether the complete diff was used, how many files
            // actually reached the prompt, and how big it got are decided here
            // and nowhere else.
            const datasetFiles = (parseMaybeJson(caseData.changedFiles) || []).length;
            const fullFiles = (parseMaybeJson(caseData.changedFilesFull) || []).length;
            const pipeline = {
                diffSource: fullFiles ? 'changedFilesFull' : 'changedFiles',
                filesInDataset: datasetFiles,
                filesInFullDiff: fullFiles,
                filesInPrompt: (input.changedFiles || []).length,
                filesWithEmptyPatch: (input.changedFiles || []).filter(
                    (f) => !String(f?.patchWithLinesStr || '').trim(),
                ).length,
                diffBlocksInPrompt: (userPrompt.match(/^### /gm) || []).length,
                legacyHunkFormat: /__new hunk__/.test(userPrompt),
                systemPromptChars: systemPrompt.length,
                userPromptChars: userPrompt.length,
                callGraphChars: String(caseData.callGraph || '').length,
                contextWindowTokens: input.contextWindowTokens || null,
                fullDiffMeta: parseMaybeJson(caseData.fullDiffMeta) || null,
                langfuseRunName: `bench:${caseData.caseId}`,
                langfuseEnvironment: process.env.LANGFUSE_ENVIRONMENT || null,
                repoPrepared: !!repoHandle,
                repoDir: repoHandle ? repoHandle.dir : null,
                headSha: repoHandle ? repoHandle.sha : null,
            };

            // RECALL_SHARD_ALT=1: a second shard draw over the SAME diff with
            // the files in reverse order. Four runs of the identical config
            // land on the same 34 goldens but swap 20 of them between runs, and
            // the union of four reaches 46% — headroom no structural change has
            // touched. File order decides what sits early in the context and
            // the plan picks its symbols from there, so reversing decorrelates
            // the second draw deliberately instead of relying on sampling
            // noise. Only the shard repeats; the generalist runs once.
            let shardAltPrompt;
            if (process.env.RECALL_SHARD_ALT === '1') {
                const files = [...(input.changedFiles || [])].reverse();
                shardAltPrompt = buildCurrentPrompts({
                    ...caseData,
                    changedFiles: JSON.stringify(
                        (parseMaybeJson(caseData.changedFiles) || []).slice().reverse(),
                    ),
                }).userPrompt;
                if (!files.length) shardAltPrompt = undefined;
            }

            stage = 'run-agent-loop';
            // runAgentLoop(input, secrets): `secrets` was split out of `input` so
            // span I/O never records keys/services. The deterministic tool replay
            // (remoteCommands) lives in `secrets` now — passing it in `input` (the
            // old single-arg shape) left the agent tool-less and crashed on
            // `secrets.byokErrorReporter`.
            const agentResult = await runAgentLoop(
                {
                    model,
                    systemPrompt,
                    userPrompt,
                    changedFiles: input.changedFiles,
                    prNumber: input.prNumber,
                    repositoryFullName: input.repositoryFullName,
                    baseBranch: input.baseBranch,
                    reviewMode: input.reviewMode,
                    maxSteps: input.maxSteps,
                    // Feeds DiffCoverageLedger → CompletionGatePolicy: without it
                    // criticalTotal is 0 and the agent may finalize with the
                    // highest-priority file untouched.
                    fileTiers: input.fileTiers,
                    // heavy força as passadas de resample (mais recall via
                    // reamostragem). É EIXO DE REGIME: comparar heavy com normal
                    // é o mesmo erro que comparar assinatura com API.
                    ...(process.env.RECALL_HEAVY === '1' ? { heavy: true } : {}),
                    // RECALL_CRITICAL_FILE_PASS=1: one whole-file finder pass per
                    // critical-tier file, on top of the diff review. Same regime
                    // caveat as heavy — it adds passes, so don't compare a run
                    // with it against a run without it as if only quality moved.
                    ...(process.env.RECALL_CRITICAL_FILE_PASS === '1'
                        ? { criticalFilePasses: true }
                        : {}),
                    // RECALL_ATOMIC_HUNKS=1: one finder pass per diff hunk of
                    // EVERY changed file (deterministic split, no scoring) — the
                    // exhaustive version of RECALL_CRITICAL_FILE_PASS. Same
                    // regime caveat: many more passes, don't compare bare.
                    ...(process.env.RECALL_ATOMIC_HUNKS === '1'
                        ? { atomicHunks: true }
                        : {}),
                    // RECALL_ATOMIC_FILES=1: one finder pass per changed FILE
                    // (all its hunks together) — coarser than ATOMIC_HUNKS,
                    // cost scales with file count instead of hunk count.
                    ...(process.env.RECALL_ATOMIC_FILES === '1'
                        ? { atomicFiles: true }
                        : {}),
                    // RECALL_CRITICAL_FILE_DEDICATED_PROMPT=1: every critical-
                    // file/atomic pass gets a dedicated base (categories +
                    // output-format reminder, no diff) instead of the full
                    // userPrompt + "ignore the diffs above" hack.
                    ...(process.env.RECALL_CRITICAL_FILE_DEDICATED_PROMPT === '1'
                        ? { criticalFileDedicatedPrompt: true }
                        : {}),
                    // RECALL_EXPERT_PANEL=1: N role-specific passes over the
                    // whole PR diff (language specialist per language present,
                    // security, performance, QA, conditional DBA) + one
                    // arbitration pass that reconciles their claims.
                    ...(process.env.RECALL_EXPERT_PANEL === '1'
                        ? { expertPanel: true }
                        : {}),
                    // RECALL_ROLE_ENSEMBLE=1: language specialist + security +
                    // performance, merged DIRECTLY (no arbitration) — the
                    // leaner, no-debate sibling of RECALL_EXPERT_PANEL.
                    ...(process.env.RECALL_ROLE_ENSEMBLE === '1'
                        ? { roleEnsemble: true }
                        : {}),
                    // RECALL_RECOGNITION_PANEL=1: 4 fixed roles chosen by
                    // recognition-failure pattern (Contract Auditor,
                    // Data-Flow/Reference Tracer, Cross-Method Consistency
                    // Checker, Failure-Path Specialist), not topic — plus a
                    // more adversarial skeptic arbitration. Different
                    // experiment from RECALL_EXPERT_PANEL/RECALL_ROLE_ENSEMBLE.
                    ...(process.env.RECALL_RECOGNITION_PANEL === '1'
                        ? { recognitionPanel: true }
                        : {}),
                    // RECALL_EXPERT_PANEL_DEDICATED_PROMPT=1: every role +
                    // arbitration pass gets a minimal diff-only base instead
                    // of the full userPrompt. Works with any of the 3 panel
                    // knobs above.
                    ...(process.env.RECALL_EXPERT_PANEL_DEDICATED_PROMPT === '1'
                        ? { expertPanelDedicatedPrompt: true }
                        : {}),
                    // RECALL_SCOUT_INVESTIGATOR=1: a cheap one-shot scout flags
                    // a few suspicious spots, then one full pass per flag
                    // investigates with dedicated tool budget.
                    ...(process.env.RECALL_SCOUT_INVESTIGATOR === '1'
                        ? { scoutInvestigator: true }
                        : {}),
                    // RECALL_SCOUT_THINKING=1: run the scout with reasoning
                    // ("medium") instead of off. Independent of
                    // RECALL_REASONING_EFFORT (which controls the
                    // investigator/main pass, not the scout).
                    ...(process.env.RECALL_SCOUT_THINKING === '1'
                        ? { scoutThinking: true }
                        : {}),
                    // RECALL_SCOUT_RESAMPLE=1: 3 sequential, context-aware
                    // scout rounds (cap 3 each) instead of 1 round (cap 5).
                    ...(process.env.RECALL_SCOUT_RESAMPLE === '1'
                        ? { scoutResample: true }
                        : {}),
                    // RECALL_SCOUT_SECOND_ROUND=1: run the scout in exactly 2
                    // rounds instead of 1 — round 1 unchanged (cap 5), then one
                    // follow-up round (cap 3) asking for OTHER spots. Isolates
                    // the two variables RECALL_SCOUT_RESAMPLE conflated (shrunk
                    // round-1 cap + two extra rounds).
                    ...(process.env.RECALL_SCOUT_SECOND_ROUND === '1'
                        ? { scoutSecondRound: true }
                        : {}),
                    // RECALL_SCOUT_LINE_HINT=1: ask the scout for the diff line
                    // each flag is anchored to, not just the file.
                    ...(process.env.RECALL_SCOUT_LINE_HINT === '1'
                        ? { scoutLineHint: true }
                        : {}),
                    // RECALL_HYPOTHESIS_DRIVEN=1: scout names a specific,
                    // falsifiable hypothesis instead of a vague flag; the
                    // investigator confirms/refutes that exact hypothesis.
                    ...(process.env.RECALL_HYPOTHESIS_DRIVEN === '1'
                        ? { hypothesisDriven: true }
                        : {}),
                    // RECALL_INVESTIGATOR_GROUP_BY_FILE=1: 2+ scout flags on
                    // the same file get ONE investigator pass instead of one
                    // pass each.
                    ...(process.env.RECALL_INVESTIGATOR_GROUP_BY_FILE === '1'
                        ? { investigatorGroupByFile: true }
                        : {}),
                    // RECALL_SCOUT_CAP=<n>: overrides the scout's default cap
                    // (5) for the single-scout path. `0` = UNCAPPED_SCOUT (ask
                    // by objective, no number in the prompt, keep every flag) —
                    // so test for presence, not truthiness.
                    ...(process.env.RECALL_SCOUT_CAP !== undefined &&
                    process.env.RECALL_SCOUT_CAP !== ''
                        ? { scoutCap: Number(process.env.RECALL_SCOUT_CAP) }
                        : {}),
                    // RECALL_CHALLENGE_DISMISSALS=1: when an investigator clears
                    // its flag after real reasoning, one follow-up pass argues
                    // the opposite case against its own prior reasoning.
                    ...(process.env.RECALL_CHALLENGE_DISMISSALS === '1'
                        ? { challengeDismissals: true }
                        : {}),
                    // RECALL_SECOND_LOOK=1: when an investigator clears its
                    // flag after making a tool call, one follow-up pass recaps
                    // its own evidence and asks about a DIFFERENT defect in
                    // the same file (not the same suspicion re-argued).
                    ...(process.env.RECALL_SECOND_LOOK === '1'
                        ? { secondLookSameFile: true }
                        : {}),
                    // RECALL_SECOND_LOOK_ALWAYS=1: fire the second look on
                    // EVERY investigator pass that made a tool call, not just
                    // the ones that cleared their flag. Requires
                    // RECALL_SECOND_LOOK=1.
                    ...(process.env.RECALL_SECOND_LOOK_ALWAYS === '1'
                        ? { secondLookAlways: true }
                        : {}),
                    // RECALL_SELECTOR_SHARD=1: plan → grep the repo → one pass
                    // per group of affected call sites. Requires
                    // RECALL_REAL_REPO=1 (recorded fixtures cannot answer a
                    // search for code the diff does not contain).
                    ...(process.env.RECALL_SELECTOR_SHARD === '1'
                        ? { selectorShard: true }
                        : {}),
                    // RECALL_GRAPH_SHARD=1: same shard pass, but the sites come
                    // from the AST blast radius instead of an LLM plan plus a
                    // grep. Costs one fewer LLM call per PR and reaches the
                    // dependents grep structurally misses (USES_TYPE/INHERITS).
                    // Requires RECALL_CALL_GRAPH=1 — without the graph there
                    // are no sites, and the pass silently does nothing.
                    // RECALL_SHARD_CAP / RECALL_SHARD_PER_WORKER: sites per PR
                    // and sites per worker. Default 6/2 (3 workers).
                    ...(process.env.RECALL_SHARD_CAP
                        ? { shardCap: Number(process.env.RECALL_SHARD_CAP) }
                        : {}),
                    ...(process.env.RECALL_SHARD_PER_WORKER
                        ? {
                              shardPerWorker: Number(
                                  process.env.RECALL_SHARD_PER_WORKER,
                              ),
                          }
                        : {}),
                    ...(shardAltPrompt ? { shardAltPrompt } : {}),
                    // RECALL_SHARD_DEDICATED=1: shard workers get their own
                    // base prompt instead of inheriting the generalist's.
                    ...(process.env.RECALL_SHARD_DEDICATED === '1'
                        ? { shardDedicatedPrompt: true }
                        : {}),
                    // RECALL_MICRO_AGENTS=1: 12 narrow passes, one per class of
                    // defect, instead of the single broad pass.
                    ...(process.env.RECALL_MICRO_AGENTS === '1'
                        ? { microAgents: true }
                        : {}),
                    // RECALL_MICRO_PLANNER=1: route first — only the classes
                    // the diff could contain get a pass.
                    ...(process.env.RECALL_MICRO_PLANNER === '1'
                        ? { microPlanner: true }
                        : {}),
                    ...(process.env.RECALL_GRAPH_SHARD === '1'
                        ? {
                              selectorShard: true,
                              // Graph-only unless the grep shard is asked for
                              // explicitly alongside it. Set both to measure
                              // the hybrid (graph where it has sites, grep
                              // elsewhere) instead of the substitution.
                              graphSitesOnly:
                                  process.env.RECALL_SELECTOR_SHARD !== '1',
                              graphSites: require(
                                  path.join(
                                      __dirname,
                                      '../../libs/code-review/infrastructure/agents/core/selector-shard.ts',
                                  ),
                              ).sitesFromCallGraph(
                                  callGraphCtx,
                                  (input.changedFiles || [])
                                      .map((f) => f.filename)
                                      .filter(Boolean),
                                  Number(process.env.RECALL_GRAPH_DEPTH || 1),
                              ),
                          }
                        : {}),
                    // RECALL_PARALLEL_SCOUT=1: run the scout chain alongside
                    // the base pass instead of after it (scheduling only).
                    ...(process.env.RECALL_PARALLEL_SCOUT === '1'
                        ? { parallelScout: true }
                        : {}),
                    // RECALL_SKIP_VERIFY=1: drop the verify stage (kept 98.2%
                    // of candidates across 5 models, at one LLM call each).
                    ...(process.env.RECALL_SKIP_VERIFY === '1'
                        ? { skipVerify: true }
                        : {}),
                    // RECALL_SCOUT_VERDICT=1: scout runs FIRST and its flags
                    // become a mandatory checklist on the generalist's prompt
                    // (no per-flag investigators). Pair with RECALL_SCOUT_CAP.
                    ...(process.env.RECALL_SCOUT_VERDICT === '1'
                        ? { scoutVerdict: true }
                        : {}),
                    // RECALL_ADVERSARIAL=1: replace the review task with a
                    // break-it task (see buildAdversarialPrompt).
                    ...(process.env.RECALL_ADVERSARIAL === '1'
                        ? { adversarial: true }
                        : {}),
                    // RECALL_FEASIBILITY_VERIFY=1: path-feasibility verify —
                    // inverted burden of proof (keep only findings whose
                    // trigger path is proven reachable+unguarded). Replaces
                    // the HV2 refute-to-drop verifier for this run.
                    ...(process.env.RECALL_FEASIBILITY_VERIFY === '1'
                        ? { feasibilityVerify: true }
                        : {}),
                    // RECALL_SECOND_LOOK_FORCE_REPORT=1: removes secondLook's
                    // "submit empty" escape hatch, forces its single most
                    // plausible candidate instead. Requires RECALL_SECOND_LOOK=1.
                    ...(process.env.RECALL_SECOND_LOOK_FORCE_REPORT === '1'
                        ? { secondLookForceReport: true }
                        : {}),
                    // RECALL_FREEFORM=1: one independent full pass, minimal
                    // senior-dev-style prompt (only anchoring kept).
                    ...(process.env.RECALL_FREEFORM === '1'
                        ? { freeformPass: true }
                        : {}),
                    // RECALL_FREEFORM_DEDICATED_PROMPT=1: freeform pass gets a
                    // minimal diff-only base instead of the full userPrompt.
                    // Requires RECALL_FREEFORM=1.
                    ...(process.env.RECALL_FREEFORM_DEDICATED_PROMPT === '1'
                        ? { freeformDedicatedPrompt: true }
                        : {}),
                    // RECALL_SCOUT_DEDICATED_PROMPT=1: scout gets a minimal
                    // diff-only prompt instead of the full userPrompt.
                    ...(process.env.RECALL_SCOUT_DEDICATED_PROMPT === '1'
                        ? { scoutDedicatedPrompt: true }
                        : {}),
                    // RECALL_SCOUT_CALIBRATED_PROMPT=1: scout gets diff +
                    // BUG/PERFORMANCE/SECURITY definitions, nothing else.
                    ...(process.env.RECALL_SCOUT_CALIBRATED_PROMPT === '1'
                        ? { scoutCalibratedPrompt: true }
                        : {}),
                    // RECALL_SCOUT_BY_CATEGORY=1: three parallel scouts, one
                    // per category, each seeing ONLY that category's
                    // definitions (cap 3 each, up to 9 total).
                    ...(process.env.RECALL_SCOUT_BY_CATEGORY === '1'
                        ? { scoutByCategory: true }
                        : {}),
                    ...(process.env.RECALL_CRITICAL_MAX_STEPS
                        ? {
                              criticalFileMaxSteps: Number(
                                  process.env.RECALL_CRITICAL_MAX_STEPS,
                              ),
                          }
                        : {}),
                    // RECALL_SKIP_SYNTHESIS=1: drop the synthesis-rescue pass.
                    // Its job (catch what the main sweep skimmed past) may be
                    // redundant once atomic-hunk passes already cover the whole
                    // diff in isolation — test the two together, not assumed.
                    ...(process.env.RECALL_SKIP_SYNTHESIS === '1'
                        ? { skipSynthesisRescue: true }
                        : {}),
                    // RECALL_SKIP_BASE_PASS=1: skip the generalist pass
                    // entirely (no LLM call) — final findings come only from
                    // whatever recall passes are configured. Pair with
                    // RECALL_SKIP_SYNTHESIS=1 for a genuine "panel only" test.
                    ...(process.env.RECALL_SKIP_BASE_PASS === '1'
                        ? { skipBasePass: true }
                        : {}),
                    agentName: `investigation-eval:${this.providerId}`,
                    // What makes a trace findable later: the case, and the
                    // knobs that defined this run. Without them every benchmark
                    // execution looks the same in Langfuse.
                    usageRunName: `bench:${caseData.caseId}`,
                    telemetryMetadata: {
                        organizationId: 'eval-org',
                        teamId: 'eval-team',
                        repositoryId: caseData.repositoryFullName,
                        pullRequestId: caseData.caseId,
                        provider: [
                            process.env.RECALL_MICRO_AGENTS === '1' && 'micro',
                            process.env.RECALL_MICRO_PLANNER === '1' && 'planner',
                            process.env.RECALL_SELECTOR_SHARD === '1' && 'shard',
                            process.env.RECALL_GRAPH_SHARD === '1' && 'graph',
                            process.env.RECALL_SKIP_BASE_PASS === '1' && 'nobase',
                            `ms${process.env.RECALL_MAX_STEPS || 12}`,
                        ]
                            .filter(Boolean)
                            .join('+'),
                    },
                },
                {
                    remoteCommands,
                    byokConfig: undefined,
                    byokErrorReporter: undefined,
                    // `input.model` is NOT read by the loop adapter. This is the
                    // seam that is — without it the run silently uses the env
                    // default under the requested model's label.
                    prebuiltModel: model,
                },
            );

            const failure = agentRunFailure(agentResult);
            if (failure) {
                throw new Error(
                    `${failure} (finishReason=${agentResult?.finishReason || 'unknown'}, ` +
                        `steps=${agentResult?.steps ?? 'n/a'}, ` +
                        `tokens=${agentResult?.usage?.totalTokens ?? 'n/a'})`,
                );
            }

            // DEDUP, ALWAYS ON BY DEFAULT (RECALL_SKIP_DEDUP=1 to opt out).
            // Production runs dedup on "the bare resolved model slot" — the
            // SAME model doing the review, not a fixed cheap one (agent-review.
            // stage.ts#deduplicateSuggestions: `resolvedSlot ?? undefined`) — so
            // this reuses the exact `model` already built above, matching that.
            // Measured (2026-09-15, DeepSeek cap5, 30 PRs): dedup drops ~57% of
            // raw candidates as redundant and roughly DOUBLES pooled F1 (0.264 ->
            // 0.398) by removing near-duplicate findings that were inflating the
            // denominator without adding a distinct real bug. Runs BEFORE the
            // judge scores anything — matching agent-review.stage.ts's real
            // order (generate -> dedup -> [rest of pipeline]) instead of scoring
            // the raw, pre-dedup candidate set. Cost is folded into tokenUsage
            // below so it's not silently absorbed into "the review's" cost.
            let dedupTrace = { status: 'skipped', reason: 'RECALL_SKIP_DEDUP=1' };
            // Snapshot BEFORE any post-processing runs. Without it a dump only
            // holds the survivors, so "would verify+dedup beat the reducer on
            // this same set?" can only be answered by re-running all 30 PRs —
            // which drags the pipeline's own +-0.026 F1 of run-to-run noise
            // into a comparison that is supposed to isolate the filter.
            const preFilterCandidates = (
                agentResult.findings?.suggestions || []
            ).map((f) => ({ ...f }));
            if (process.env.RECALL_SKIP_DEDUP !== '1') {
                const rawFindings = agentResult.findings?.suggestions || [];
                if (rawFindings.length > 1) {
                    try {
                        const { runDedup } = require('../dedup/dedup-runner.js');
                        const { readAiSdkUsage } = require(
                            path.join(
                                __dirname,
                                '../../libs/llm/ai-sdk-usage.ts',
                            ),
                        );
                        const useReducer = process.env.RECALL_REDUCER === '1';
                        if (useReducer) {
                            // REDUCER: one pass over the WHOLE candidate set —
                            // merges, drops on merit and orders by importance,
                            // replacing verify (per-finding, blind to the rest)
                            // and dedup (whole set, but only asks "same bug?").
                            const { runReducer } = require('../dedup/reducer-runner.js');
                            const r = await runReducer(rawFindings, { model });
                            for (const [idx, from] of r.merged) {
                                const rep = rawFindings[idx];
                                if (!rep || !from.length) continue;
                                const locs = from
                                    .filter((d) => rawFindings[d])
                                    .map((d) => {
                                        const f = rawFindings[d];
                                        return `${f.relevantFile}${f.relevantLinesStart ? ':' + f.relevantLinesStart : ''}`;
                                    });
                                if (locs.length) {
                                    rep.suggestionContent = `${rep.suggestionContent || ''}\n\nAlso found in: ${[...new Set(locs)].join(', ')}`.trim();
                                }
                            }
                            const beforeR = rawFindings.length;
                            agentResult.findings.suggestions = r.kept
                                .map((i) => rawFindings[i])
                                .filter(Boolean);
                            const ru = readAiSdkUsage(r.usage) || {};
                            agentResult.usage = {
                                ...agentResult.usage,
                                inputTokens: (agentResult.usage.inputTokens || 0) + (ru.inputTokens || 0),
                                outputTokens: (agentResult.usage.outputTokens || 0) + (ru.outputTokens || 0),
                                totalTokens: (agentResult.usage.totalTokens || 0) + (ru.totalTokens || 0),
                                cacheReadTokens: (agentResult.usage.cacheReadTokens || 0) + (ru.cacheReadTokens || 0),
                                cacheWriteTokens: (agentResult.usage.cacheWriteTokens || 0) + (ru.cacheWriteTokens || 0),
                                reasoningTokens: (agentResult.usage.reasoningTokens || 0) + (ru.reasoningTokens || 0),
                            };
                            dedupTrace = {
                                status: 'reducer',
                                before: beforeR,
                                after: agentResult.findings.suggestions.length,
                                merged: r.merged.size,
                                dropped: r.dropped.length,
                                noOp: !!r.noOp,
                            };
                        } else {
                        const dedupResult = await runDedup(rawFindings, undefined, {
                            model,
                            // RECALL_DEDUP_ROOT_CAUSE=1: also merge SYSTEMIC
                            // root-cause repeats (same mistake across N call
                            // sites) — see buildDedupPrompt's mergeRootCause.
                            mergeRootCause:
                                process.env.RECALL_DEDUP_ROOT_CAUSE === '1',
                        });
                        // Defense in depth: `unmentioned` are items the dedup
                        // model's response never classified as kept OR dropped
                        // (parse gaps, unexpected field names, empty response).
                        // Silently dropping them would be a RECALL regression
                        // (losing a real, non-duplicate finding) to fix a
                        // precision problem — treat "couldn't classify" the
                        // same as "keep it", matching the noOp keep-all
                        // fallback's own safety posture.
                        const keptSet = new Set([...dedupResult.kept, ...(dedupResult.unmentioned || [])]);
                        // Merged groups keep ONE comment but must not lose the
                        // other locations — append them to the representative,
                        // same "Also found in" pattern production's kody-rules
                        // dedup uses. Plain code, no extra LLM call.
                        for (const g of dedupResult.groups || []) {
                            const rep = rawFindings[g.keep];
                            if (!rep) continue;
                            const others = (g.duplicates || [])
                                .filter((d) => !keptSet.has(d) && rawFindings[d])
                                .map((d) => {
                                    const f = rawFindings[d];
                                    const loc = f.relevantLinesStart
                                        ? `:${f.relevantLinesStart}`
                                        : '';
                                    return `${f.relevantFile}${loc}`;
                                });
                            if (others.length) {
                                rep.suggestionContent =
                                    `${rep.suggestionContent || ''}\n\nAlso found in: ${[...new Set(others)].join(', ')}`.trim();
                            }
                        }
                        const before = rawFindings.length;
                        agentResult.findings.suggestions = rawFindings.filter((_, i) => keptSet.has(i));
                        const dedupUsage = readAiSdkUsage(dedupResult.usage) || {};
                        agentResult.usage = {
                            ...agentResult.usage,
                            inputTokens: (agentResult.usage.inputTokens || 0) + (dedupUsage.inputTokens || 0),
                            outputTokens: (agentResult.usage.outputTokens || 0) + (dedupUsage.outputTokens || 0),
                            totalTokens: (agentResult.usage.totalTokens || 0) + (dedupUsage.totalTokens || 0),
                            cacheReadTokens: (agentResult.usage.cacheReadTokens || 0) + (dedupUsage.cacheReadTokens || 0),
                            cacheWriteTokens: (agentResult.usage.cacheWriteTokens || 0) + (dedupUsage.cacheWriteTokens || 0),
                            reasoningTokens: (agentResult.usage.reasoningTokens || 0) + (dedupUsage.reasoningTokens || 0),
                        };
                        dedupTrace = {
                            status: 'success',
                            before,
                            after: agentResult.findings.suggestions.length,
                            groups: dedupResult.groups?.length ?? 0,
                            noOp: !!dedupResult.noOp,
                        };
                        }
                    } catch (dedupError) {
                        dedupTrace = {
                            status: 'failed-keep-all',
                            errorMessage: dedupError instanceof Error ? dedupError.message : String(dedupError),
                        };
                    }
                } else {
                    dedupTrace = { status: 'skipped', reason: '<=1 candidate' };
                }
            }

            stage = 'verify-model-served';
            const evalStats = model && model.__evalStats;
            if (evalStats && evalStats.calls === 0) {
                throw new Error(
                    `model ${evalStats.label} never served a call — the run used ` +
                        'some other model. Refusing to publish a mislabelled result.',
                );
            }

            stage = 'serialize-result';
            const output = serializeResult(
                caseData.caseId || 'unknown-case',
                agentResult,
                remoteCommands,
                input,
                evalStats && { modelId: evalStats.modelId, calls: evalStats.calls },
                dedupTrace,
                preFilterCandidates,
                pipeline,
            );
            writeResultArtifact('last-output.json', output);

            return {
                output: JSON.stringify(output),
                tokenUsage: {
                    prompt: agentResult.usage.inputTokens,
                    completion: agentResult.usage.outputTokens,
                    total: agentResult.usage.totalTokens,
                    // cacheReadTokens/cacheWriteTokens/reasoningTokens were
                    // already computed correctly (finder + verify + every
                    // recall pass) in agentResult.usage — just never surfaced
                    // here, so every past run's true cache split was
                    // unrecoverable once the RECALL_DUMP raw files were
                    // cleaned up. cacheWriteTokens stays 0 on providers that
                    // don't report it (see core-agent-loop.adapter.ts).
                    cacheReadTokens: agentResult.usage.cacheReadTokens ?? 0,
                    cacheWriteTokens: agentResult.usage.cacheWriteTokens ?? 0,
                    reasoningTokens: agentResult.usage.reasoningTokens ?? 0,
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
// createModel exported so other scripts (e.g. the dedup post-processor) can
// build the SAME model a recall run used — production runs dedup on "the bare
// resolved model slot" (the review's own model), not a fixed secondary one.
module.exports.createModel = createModel;
// Exported so a prompt-shape check can run without spending a model call.
module.exports.buildCurrentPrompts = buildCurrentPrompts;
