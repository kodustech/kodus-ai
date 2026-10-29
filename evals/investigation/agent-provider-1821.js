require('ts-node/register/transpile-only');

require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const { resolveContextWindow } = require(
    path.join(__dirname, '../../libs/llm/model-context-window.ts'),
);
const { chamadaEstruturada } = require('./eval-structured');

const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });

/**
 * RECALL_RAW_HTTP_DIR: grava cada chamada HTTP da rodada, crua — corpo do
 * pedido, status, cabecalhos e corpo da resposta — um arquivo por chamada.
 * Serve para ver o que o provedor devolveu de fato (stop_reason, blocos de
 * conteudo, uso) quando o harness recebe algo quebrado. O SDK resolve
 * globalThis.fetch na hora da chamada, entao embrulhar aqui pega todas.
 * Os cabecalhos de autenticacao nao sao gravados.
 */
if (process.env.RECALL_RAW_HTTP_DIR) {
    const dir = process.env.RECALL_RAW_HTTP_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const original = globalThis.fetch;
    const SEGREDO = /^(authorization|x-api-key|api-key|x-goog-api-key|cookie|set-cookie)$/i;
    let seq = 0;
    const gravar = (arquivo, dados) => {
        try {
            fs.writeFileSync(path.join(dir, arquivo), JSON.stringify(dados));
        } catch {}
    };
    globalThis.fetch = async (input, init) => {
        const n = ++seq;
        const url = typeof input === 'string' ? input : (input?.url ?? String(input));
        const inicio = Date.now();
        const arquivo = `http-${process.pid}-${inicio}-${n}.json`;
        const request = typeof init?.body === 'string' ? init.body : null;
        let res;
        try {
            res = await original(input, init);
        } catch (err) {
            gravar(arquivo, { url, request, error: String(err) });
            throw err;
        }
        const headers = {};
        res.headers.forEach((v, k) => {
            if (!SEGREDO.test(k)) headers[k] = v;
        });
        res.clone()
            .text()
            .then((response) =>
                gravar(arquivo, { url, ms: Date.now() - inicio, request, status: res.status, headers, response }),
            )
            .catch((err) => gravar(arquivo, { url, request, status: res.status, headers, error: String(err) }));
        return res;
    };
}

/**
 * Busca de documentacao (searchDocs, Exa) — a mesma ferramenta que a producao
 * da aos agentes quando API_EXA_KEY existe (base-code-review-agent.provider.ts).
 * O eval nunca a passava, entao todo agente do benchmark investigava contrato
 * de biblioteca sem poder consultar a documentacao que o produto consulta.
 *
 * Ligada por padrao, porque o benchmark mede o produto. RECALL_DOCS=0 desliga,
 * para o braco de comparacao. O cache da producao mora no Mongo com TTL de 24h;
 * aqui ele vive em memoria durante a rodada, o que so muda o custo, nao a resposta.
 */
/**
 * Janela de contexto do modelo servido, resolvida pelo id REAL do provedor —
 * como a producao faz com o id do slot BYOK. O apelido do eval
 * (`deepseek-v4.1-flash@fireworks`) nao existe na tabela e caia no padrao de
 * 128k, contra ~1M do modelo: o compressor passava a cortar o historico do
 * agente a partir de ~90k tokens, coisa que a producao nao faz.
 */
function janelaDoModelo() {
    const apelido = process.env.RECALL_MODEL || '';
    const { TIER0 } = require('../shared/tier0-models');
    const real = TIER0[apelido]?.doModel || apelido.replace(/@sub$/, '');
    return resolveContextWindow({ modelName: real });
}

let docsSearchSingleton;
function docsSearchService() {
    if (process.env.RECALL_DOCS === '0' || !process.env.API_EXA_KEY) return undefined;
    if (docsSearchSingleton) return docsSearchSingleton;
    const {
        DocumentationSearchExaService,
    } = require('../../libs/code-review/infrastructure/adapters/services/documentation-search-exa.service.ts');
    const cache = new Map();
    const chave = (p) => `${p.provider}|${p.packageNameNormalized}|${p.queryNormalized}`;
    docsSearchSingleton = new DocumentationSearchExaService(
        { get: (k) => process.env[k] },
        {
            get: async (p) => cache.get(chave(p)) || null,
            set: async (p) => { cache.set(chave(p), p.documentationItem); },
        },
        undefined,
    );
    return docsSearchSingleton;
}

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

function embaralharArquivos(files, seed, salt) {
    if (!seed || !Array.isArray(files) || files.length < 2) return files;
    let h = 2166136261;
    for (const ch of `${seed}:${salt}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    const rand = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0), (h ^= h >>> 13), (h >>> 0) / 4294967296);
    const out = files.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
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
/** Runner do Claude Agent SDK quando RECALL_MODEL e um `@sdk`; undefined no resto. */
function claudeSdkRunner(cwd) {
    const spec = require('../shared/tier0-models').TIER0[process.env.RECALL_MODEL || ''];
    if (!spec || spec.provider !== 'claude_agent_sdk') return undefined;
    const { ClaudeSdkRunner } = require('./claude-sdk-runner');
    return new ClaudeSdkRunner(spec.sdkModel, { effort: process.env.RECALL_REASONING_EFFORT || undefined, cwd });
}

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
 * Limite por chamada ao modelo, com UMA nova tentativa (#1821, smoke de 01/10).
 * O unico limite do harness e LLM_CALL_TIMEOUT_MS (20 min), alto de proposito
 * por causa do Gemini em producao. No smoke, DeepSeek (Fireworks) e Kimi K3
 * (Moonshot) tiveram cada um uma chamada que nunca voltou: a lente ficou 1218 s
 * com 0 passos e segurou o PR inteiro. A chamada legitima mais lenta medida foi
 * 546 s (Kimi K3, lente de 1 passo), entao 10 min nao corta ninguem que ia
 * terminar. RECALL_CALL_TIMEOUT_MS muda o limite; 0 desliga.
 */
function withCallTimeout(model) {
    const ms = Number(process.env.RECALL_CALL_TIMEOUT_MS ?? 10 * 60 * 1000);
    if (!ms) return model;
    const tentar = async (target, prop, options, resta) => {
        const ctrl = new AbortController();
        const pai = options?.abortSignal;
        if (pai) {
            if (pai.aborted) ctrl.abort(pai.reason);
            else pai.addEventListener('abort', () => ctrl.abort(pai.reason), { once: true });
        }
        let expirou = false;
        const timer = setTimeout(() => { expirou = true; ctrl.abort(new Error(`chamada passou de ${ms} ms`)); }, ms);
        try {
            return await target[prop]({ ...options, abortSignal: ctrl.signal });
        } catch (e) {
            if (expirou && resta > 0 && !pai?.aborted) {
                console.warn(`[timeout] chamada passou de ${Math.round(ms / 1000)}s; nova tentativa`);
                return tentar(target, prop, options, resta - 1);
            }
            throw e;
        } finally {
            clearTimeout(timer);
        }
    };
    return new Proxy(model, {
        get(target, prop, receiver) {
            if (prop === 'doGenerate' || prop === 'doStream') {
                return async (options) => tentar(target, prop, options, 1);
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}

/**
 * `prompt_cache_key` por PR nas chamadas da OpenAI (#1821, plano de teste de
 * 30/09: cache entre passadas como a producao faria). As passadas de um PR
 * mandam o mesmo prefixo (o diff vem primeiro); sem a chave, a OpenAI espalha as
 * chamadas paralelas por maquinas diferentes e o GPT-6 leu 0% de cache entre
 * passadas, contra 74-76% no DeepSeek.
 *
 * Fica POR DENTRO do withReasoningEffort: aquele troca o bloco `openai` inteiro
 * das providerOptions, e uma chave posta antes dele sumiria. Aqui a chave e
 * mesclada no bloco que chegar.
 */
function withPromptCacheKey(model, key) {
    const merge = (options) => ({
        ...options,
        providerOptions: {
            ...(options?.providerOptions || {}),
            openai: { ...(options?.providerOptions?.openai || {}), promptCacheKey: key },
        },
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

async function createModel(config, caseId) {
    if (config.provider === 'tier0') {
        const modelId = process.env.RECALL_MODEL || config.model;
        const { applyModelEnv, TIER0 } = require('../shared/tier0-models');

        // Assinatura: nao passa por buildModelFromSlot (que espera chave de API).
        // Fala com chatgpt.com/backend-api via token OAuth do Codex; o wrapper
        // resolve o streaming-only + store:false.
        const spec = TIER0[modelId];
        if (spec && spec.provider === 'claude_agent_sdk') {
            return require('./claude-sdk-runner').modeloFachada(spec.sdkModel, { effort: process.env.RECALL_REASONING_EFFORT || undefined });
        }

        if (spec && spec.provider === 'codex_subscription') {
            const { buildCodexSubscriptionModel } = require('../../libs/llm/codex-subscription-model.ts');
            return withCallCounter(
                buildCodexSubscriptionModel(spec.codexModel || modelId),
                spec.codexModel || modelId,
            );
        }

        // API nativa da OpenAI como no BYOK da nuvem: o modulo 'openai' do
        // registro (createOpenAI -> Responses API). O caminho de env (managed)
        // trata chave OpenAI como openai_compatible (/v1/chat/completions), onde
        // o gpt-6-sol recusa ferramentas com reasoning_effort.
        if (spec && spec.byokNative) {
            const { REGISTRY } = require('../../libs/llm/providers/index.ts');
            const apiKey = spec.keyEnvs.map((e) => process.env[e]).find(Boolean);
            if (!apiKey) throw new Error(`no API key for ${modelId} — set one of ${spec.keyEnvs.join('/')}`);
            const id = spec.doModel || modelId;
            const built = REGISTRY.get(spec.provider).build({ provider: spec.provider, model: id, apiKey }, {});
            // A OpenAI limita prompt_cache_key a 64 caracteres, e o caseId passa
            // disso em 22 dos 30 PRs: vai um hash curto e estavel dele.
            const chave = caseId
                ? `kb-${require('crypto').createHash('sha256').update(caseId).digest('hex').slice(0, 32)}`
                : null;
            const comCache = spec.provider === 'openai' && chave ? withPromptCacheKey(built, chave) : built;
            return withCallCounter(withReasoningEffort(withCallTimeout(comCache), id), modelId);
        }

        if (spec && spec.openrouterProviderOrder?.length) {
            const { modeloOpenRouterFixo } = require('./eval-model');
            return withCallCounter(withReasoningEffort(withCallTimeout(modeloOpenRouterFixo(modelId)), modelId), modelId);
        }

        const { buildEvalModel } = require('../shared/build-model');
        applyModelEnv(modelId);
        return withCallCounter(
            withReasoningEffort(withCallTimeout(buildEvalModel({})), modelId),
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

function prodMaxSteps(caseData) {
    const files = Array.isArray(caseData.prFiles)
        ? caseData.prFiles.length
        : (parseMaybeJson(caseData.changedFiles) || []).length;
    if (files <= 8) return 20;
    return Math.min(20 + Math.round((files - 8) * 0.5), 100);
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
        // RECALL_DIFF_SHUFFLE_SEED=<n>: ordem dos arquivos do diff embaralhada,
        // deterministica por semente + PR (como os passes do Bugbot v1). So o
        // eval liga; sem a env a ordem e a da producao.
        changedFiles: embaralharArquivos(
            normalizeChangedFiles(
                parseMaybeJson(caseData.changedFilesFull) ||
                    parseMaybeJson(caseData.changedFiles),
            ),
            process.env.RECALL_DIFF_SHUFFLE_SEED,
            caseData.id || caseData.caseId || '',
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
        // RECALL_PROD_STEPS=1: production's step budget instead of the 12 cap —
        // review-orchestrator.service.ts getMaxStepsForAgent, normal mode:
        // 20 for the generalist, +0.5 per changed file above 8, capped at 100.
        // On 20/10/26 the 12 cap cut Kimi and DeepSeek to half of the steps the
        // production finder took; keep this in sync with that method on merge.
        maxSteps:
            Number(process.env.RECALL_MAX_STEPS) ||
            (process.env.RECALL_PROD_STEPS === '1'
                ? prodMaxSteps(caseData)
                : caseData.maxSteps || 12),
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
        contextWindowTokens: janelaDoModelo(),
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

// Production's local sandbox (the self-hosted path) with exec, over a prepared
// worktree: the same grep/read/listDir/exec, and so the same exec-gated tools
// (checkTypes, findNearestProjectFile, findFile's find path), a self-hosted
// customer's agent gets. See evals/shared/local-sandbox.js.
function sandboxCommands(repoDir) {
    return require('../shared/local-sandbox').comandosSandboxLocal(repoDir);
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

/**
 * Impressao digital da configuracao que produziu o dump. Duas rodadas so se
 * comparam se ela bate. Sem isso, a janela do GPT mudou de 400k para 922k num
 * merge e ninguem viu; e um pool colado de duas rodadas com numero de passadas
 * diferente passou por baseline.
 *
 * O hash e do CONTEUDO dos arquivos, nao do commit: a VM do runo recebe um
 * snapshot com commit proprio, e alteracao nao commitada tambem muda o que roda.
 */
let fingerprintCache;
function runFingerprint() {
    if (fingerprintCache) return fingerprintCache;
    const crypto = require('crypto');
    const { execSync } = require('child_process');
    const raiz = path.join(__dirname, '../..');
    const hashDe = (padroes) => {
        const h = crypto.createHash('sha256');
        const arquivos = execSync(`git ls-files -co --exclude-standard -- ${padroes}`, { cwd: raiz })
            .toString().split('\n').filter(Boolean).sort();
        for (const f of arquivos) {
            try { h.update(f).update(fs.readFileSync(path.join(raiz, f))); } catch { /* removido */ }
        }
        return h.digest('hex').slice(0, 12);
    };
    fingerprintCache = {
        codeHash: hashDe("libs/code-review libs/llm libs/agent-harness 'evals/investigation/*.js'"),
        datasetsHash: hashDe('evals/investigation/datasets'),
        model: process.env.RECALL_MODEL || null,
        reasoningEffort: process.env.RECALL_REASONING_EFFORT || null,
        contextWindowTokens: janelaDoModelo(),
        docsSearch: !!docsSearchService(),
        env: Object.fromEntries(
            Object.entries(process.env)
                .filter(([k]) => k.startsWith('RECALL_') && !/KEY|TOKEN|SECRET/i.test(k))
                // Quais PRs e onde gravar nao sao configuracao: dizem O QUE rodar, nao COMO.
                .filter(([k]) => !['RECALL_DUMP', 'RECALL_CONCURRENCY', 'RECALL_CASES', 'RECALL_START_STAGGER_MS'].includes(k))
                .sort(),
        ),
    };
    return fingerprintCache;
}

function serializeResult(caseId, agentResult, remoteCommands, input, modelStats, dedupTrace, preFilterCandidates, pipeline) {
    return {
        caseId,
        config: runFingerprint(),
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
            pipeline: pipeline || null,
            dedup: dedupTrace || null,
            // The candidate set as it stood before dedup/reducer, each item
            // tagged with the pass that produced it (`producedBy`). This is
            // what makes offline filter A/B possible.
            preFilterCandidates: (preFilterCandidates || []).map((f) => ({
                ...f,
                producedBy: f.producedBy || 'generalist-base',
            })),
            droppedByParseSchema: agentResult.droppedByParseSchema || [],
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
            repoPrepared: !!pipeline?.repoPrepared,
            headSha: pipeline?.headSha ?? null,
            // false: the exec-gated tools were not registered for this case.
            sandboxExec: typeof remoteCommands.exec === 'function',
            // RECALL_SANDBOX=e2b: create+clone time and tool-call latency in the sandbox.
            sandbox: typeof remoteCommands.sandboxStats === 'function' ? remoteCommands.sandboxStats() : null,
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
        let e2b = null;
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
            const model = await createModel(this.config, caseData.caseId);

            stage = 'build-replay-commands';
            // RECALL_REAL_REPO=1: answer the tools from a git worktree at the
            // PR's head instead of replaying recorded tool calls. The replay
            // only answers calls captured when the dataset was built; any other
            // call gets an empty answer the real repository would not give.
            // Falls back to replay when the commit can't be fetched;
            // `repoPrepared` in the trace says which one ran.
            let remoteCommands;
            if (process.env.RECALL_REAL_REPO === '1') {
                const { prepareRepo } = require('./prepare-repo');
                repoHandle = await prepareRepo(caseData, caseData.caseId);
                // RECALL_SANDBOX=e2b: the tools run in production's E2B sandbox
                // (production template, with exec) at the PR's head commit. The
                // local worktree stays for the call graph the eval builds.
                if (repoHandle && process.env.RECALL_SANDBOX === 'e2b') {
                    const { abreSandboxE2B } = require('../shared/e2b-sandbox');
                    e2b = await abreSandboxE2B(caseData, 'finder');
                    remoteCommands = e2b.commands;
                    remoteCommands.sandboxStats = e2b.stats;
                } else if (repoHandle) remoteCommands = sandboxCommands(repoHandle.dir);
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
            if (process.env.RECALL_CALL_GRAPH === '1' && repoHandle) {
                const { buildPrCallGraph } = require('./build-pr-callgraph');
                const cg = await buildPrCallGraph(
                    caseData,
                    repoHandle.dir,
                    caseData.caseId,
                    (m) => console.log(m),
                );
                if (cg) caseData.callGraph = cg.xml;
            }

            stage = 'build-prompts';
            const prompts = buildCurrentPrompts(caseData);
            const { input, systemPrompt, userPrompt } = prompts;
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
                    // RECALL_SKIP_SYNTHESIS=1: drop the synthesis-rescue pass.
                    ...(process.env.RECALL_SKIP_SYNTHESIS === '1'
                        ? { skipSynthesisRescue: true }
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
                        provider: `ms${process.env.RECALL_MAX_STEPS || 12}`,
                    },
                },
                {
                    remoteCommands,
                    byokConfig: undefined,
                    byokErrorReporter: undefined,
                    documentationSearchService: docsSearchService(),
                    documentationSearchOptions: { prNumber: input.prNumber },
                    // `input.model` is NOT read by the loop adapter. This is the
                    // seam that is — without it the run silently uses the env
                    // default under the requested model's label.
                    prebuiltModel: model,
                    // A recuperacao de prosa e uma chamada avulsa. Modelos com chave
                    // (DeepSeek etc.) ja chegam nela pelo padrao do ambiente
                    // (applyModelEnv), que sabe o formato de JSON do provedor; so a
                    // assinatura do Codex nao tem esse caminho. Passar o modelo pronto
                    // para todos fez o DeepSeek falhar "did not match schema" (26/09).
                    prebuiltRunner: claudeSdkRunner(repoHandle ? repoHandle.dir : undefined),
                    prebuiltRecoveryModel:
                        (require('../shared/tier0-models').TIER0[process.env.RECALL_MODEL || '']?.provider === 'codex_subscription' ||
                            require('../shared/tier0-models').TIER0[process.env.RECALL_MODEL || '']?.provider === 'claude_agent_sdk' ||
                            require('../shared/tier0-models').TIER0[process.env.RECALL_MODEL || '']?.byokNative)
                            ? model
                            : undefined,
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
            // Production's parse schema (agent-review.stage.ts, parseFinderSchema)
            // discards a finding with no file, lines or text before anything else
            // sees it, and a finding on a file outside the PR cannot be anchored.
            // Neither becomes a comment, so neither reaches the score.
            const droppedByParseSchema = [];
            if (agentResult.findings?.suggestions) {
                const { parseFinderSchema } = require(
                    path.join(__dirname, '../../libs/code-review/infrastructure/agents/engine/parse-finder-schema.ts'),
                );
                const prFiles = new Set(
                    (Array.isArray(caseData.prFiles) ? caseData.prFiles : input.changedFiles || []).map((f) => f.filename),
                );
                const all = agentResult.findings.suggestions;
                const invalid = new Set(parseFinderSchema(all).discarded.map((d) => d.index));
                agentResult.findings.suggestions = all.filter((f, i) => {
                    const reason = invalid.has(i)
                        ? 'missing-field'
                        : f.label !== 'kody_rules' && !prFiles.has(f.relevantFile)
                          ? 'file-not-in-pr'
                          : null;
                    if (reason) droppedByParseSchema.push({ ...f, reason });
                    return !reason;
                });
                agentResult.droppedByParseSchema = droppedByParseSchema;
            }
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

            // ===================== GATE DA PROVA =====================
            // Estagio do fluxo, depois do reducer. Nao e filtro offline: o que
            // sai daqui e o que o pipeline entrega.
            //
            // A regra inverte o onus da prova. O default de todo filtro que
            // testamos era "mantem a menos que alguem refute", e refutar se
            // mostrou o lado fraco — num conjunto de 154 achados, exigir prova
            // derrubou 29 e refutar derrubou 8. Aqui o achado so passa se
            // alguem conseguir PROVA-LO, de uma de duas formas: instanciar a
            // falha (entrada concreta -> saida errada concreta) ou apontar uma
            // contradicao documentada (o que o codigo promete x o que ele faz,
            // os dois com file:line). Nao conseguiu nenhuma das duas, cai.
            //
            // Sem ferramenta de proposito: o contexto vai PRONTO (o diff do
            // arquivo e a fatia em volta de cada file:line que o proprio achado
            // cita). Com DeepSeek, agente com ferramenta sofre "scope drift" e
            // mata achado bom por argumento de escopo — medido aqui e tambem
            // no estudo comparativo de filtros de falso positivo.
            //
            // Medido sobre 154 achados: precision 37.0% -> 42.2%, recall
            // 60.0% -> 56.8%, F1 0.458 -> 0.484.
            stage = 'gate';
            let gateTrace = null;
            if (process.env.RECALL_GATE === '1') {
                const posReducer = agentResult.findings?.suggestions || [];
                if (posReducer.length) {
                    try {
                        const { generateText, tool, jsonSchema } = require('ai');
                        const diffsPorArquivo = Object.fromEntries(
                            (input.changedFiles || []).map((f) => [
                                f.filename,
                                f.patchWithLinesStr || f.patch || '',
                            ]),
                        );
                        const refs = (txt) => {
                            const out = [];
                            const re = /([\w./\-]+\.\w{1,6}):(\d+)/g;
                            let m;
                            while ((m = re.exec(String(txt || ''))) && out.length < 8) {
                                out.push({ file: m[1], line: Number(m[2]) });
                            }
                            return out;
                        };
                        const fatiar = async (c) => {
                            const alvos = [
                                { file: c.relevantFile, line: c.relevantLinesStart },
                                ...refs(c.reason),
                                ...refs(c.suggestionContent),
                            ];
                            const vistos = new Set();
                            const partes = [];
                            for (const a of alvos) {
                                if (!a.file || !a.line) continue;
                                const k = `${a.file}:${Math.floor(a.line / 30)}`;
                                if (vistos.has(k)) continue;
                                vistos.add(k);
                                try {
                                    const t = await remoteCommands.read(
                                        a.file,
                                        Math.max(1, a.line - 18),
                                        a.line + 18,
                                    );
                                    if (t)
                                        partes.push(
                                            `--- ${a.file}:${Math.max(1, a.line - 18)}-${a.line + 18}\n${String(t).slice(0, 2600)}`,
                                        );
                                } catch {}
                                if (partes.length >= 5) break;
                            }
                            return partes.join('\n\n') || '(could not read the code)';
                        };

                        const PROVAR_SCHEMA = {
                            type: 'object',
                            properties: {
                                tipo: {
                                    type: 'string',
                                    enum: ['falha', 'contradicao', 'nenhuma'],
                                },
                                entrada: { type: 'string' },
                                saida: { type: 'string' },
                                promete: { type: 'string' },
                                faz: { type: 'string' },
                            },
                            required: ['tipo', 'entrada', 'saida', 'promete', 'faz'],
                            additionalProperties: false,
                        };
                        const provarTool = tool({
                            description: 'Records the proof. Call exactly once.',
                            inputSchema: jsonSchema(PROVAR_SCHEMA),
                            execute: async () => ({ output: 'ok' }),
                        });

                        const prompt = (c, fatia) => `<Finding>
  file: ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
  ${c.oneSentenceSummary || ''}
  ${String(c.suggestionContent || '').slice(0, 900)}
</Finding>

<WalkTheReviewerRecorded>
${String(c.reason || '(none recorded)').slice(0, 1000)}
</WalkTheReviewerRecorded>

<DiffOfThatFile>
${String(diffsPorArquivo[c.relevantFile] || '(unavailable)').slice(0, 5000)}
</DiffOfThatFile>

<CodeAroundEveryLineTheFindingCites>
${fatia}
</CodeAroundEveryLineTheFindingCites>

Your job is to prove this finding, using only the code above. There are exactly
two ways to prove one, and you must pick the one that fits.

WAY 1 — "falha": the code misbehaves at runtime.
Write the concrete input or program state that drives it into the failure, and
the concrete wrong thing that comes out. Concrete means values a person could
type: this field is the empty string, this list has 0 elements, this call
returns null, two requests arrive in this order. "A large input" is not a value.
Then say what comes out: the wrong number, the exception and where it is thrown,
the row that ends up corrupted, the request that gets through the check.

WAY 2 — "contradicao": something in the code states a promise that another part
of the code breaks, and both are written down. A docstring or comment that
describes behaviour the function does not have. An exported or declared name
that does not match what the thing is. A test whose name describes a case its
body does not exercise. A signature, annotation or type that disagrees with the
implementation. Quote BOTH sides with file:line — what it promises, and what it
actually does. Nothing runs wrong here; the mismatch itself is the defect, and
it is only a defect if you can point at both halves.

If neither fits, answer "nenhuma". That is a normal and correct outcome — use it
when the finding is a preference about how the code is written, when it asks for
a defence no caller violates, when the behaviour predates this change and the
diff did not touch it, or when the path is guarded so the failure cannot occur.
Do not stretch a style preference into a contradiction, and do not invent a
scenario to fill the fields.

Call provar exactly once.`;

                        const PAR = Number(process.env.RECALL_GATE_PAR || 4);
                        const decidido = [];
                        for (let b = 0; b < posReducer.length; b += PAR) {
                            const lote = await Promise.all(
                                posReducer.slice(b, b + PAR).map(async (c) => {
                                    try {
                                        const fatia = await fatiar(c);
                                        const r = await chamadaEstruturada({
                                            model,
                                            modelId: process.env.RECALL_MODEL,
                                            nome: 'provar',
                                            schema: PROVAR_SCHEMA,
                                            toolDef: provarTool,
                                            prompt: prompt(c, fatia),
                                        });
                                        const a = r.dados;
                                        // Chamada que falhou nao pode virar
                                        // descarte: o portao so fecha com
                                        // resposta, nunca com ausencia dela.
                                        return { c, tipo: a?.tipo || 'erro' };
                                    } catch {
                                        return { c, tipo: 'erro' };
                                    }
                                }),
                            );
                            decidido.push(...lote);
                        }
                        const mantidos = decidido.filter((d) => d.tipo !== 'nenhuma');
                        gateTrace = {
                            status: 'gate',
                            // O CONJUNTO, nao so a contagem. Sem ele nao da
                            // para testar offline um filtro que SUBSTITUA o
                            // gate: a entrada dele e a saida do reducer, e essa
                            // so existia como numero.
                            entrada: posReducer.map((c) => ({
                                relevantFile: c.relevantFile,
                                relevantLinesStart: c.relevantLinesStart,
                                relevantLinesEnd: c.relevantLinesEnd,
                                oneSentenceSummary: c.oneSentenceSummary,
                                suggestionContent: c.suggestionContent,
                                existingCode: c.existingCode,
                                reason: c.reason,
                                severity: c.severity,
                                producedBy: c.producedBy,
                            })),
                            before: posReducer.length,
                            after: mantidos.length,
                            falha: decidido.filter((d) => d.tipo === 'falha').length,
                            contradicao: decidido.filter((d) => d.tipo === 'contradicao').length,
                            nenhuma: decidido.filter((d) => d.tipo === 'nenhuma').length,
                            erro: decidido.filter((d) => d.tipo === 'erro').length,
                        };
                        agentResult.findings.suggestions = mantidos.map((d) => d.c);
                        console.log(
                            `   [gate] ${gateTrace.before} → ${gateTrace.after} · falha ${gateTrace.falha} · contradicao ${gateTrace.contradicao} · descartados ${gateTrace.nenhuma} · erro ${gateTrace.erro}`,
                        );
                    } catch (gateError) {
                        gateTrace = {
                            status: 'failed',
                            reason: String(gateError?.message || gateError).slice(0, 200),
                        };
                        console.log(`   [gate] falhou: ${gateTrace.reason}`);
                    }
                } else {
                    gateTrace = { status: 'skipped', reason: 'nada pos-reducer' };
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
                { ...pipeline, gate: gateTrace },
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
            if (e2b) {
                try {
                    await e2b.cleanup();
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
