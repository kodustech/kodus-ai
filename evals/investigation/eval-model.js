/**
 * Constrói o modelo dos scripts offline a partir de `RECALL_MODEL`.
 *
 * Existia hardcoded como `buildCodexSubscriptionModel` em quatro scripts, o
 * que amarrou toda a investigação a uma conta de assinatura — quando a cota
 * dela acabou, nenhum experimento podia rodar sem editar código.
 *
 * Duas rotas, escolhidas pelo formato do id:
 *   - `@sub` ou um id conhecido do TIER0 com provider codex_subscription vai
 *     pelo wrapper de assinatura (streaming-only, store:false).
 *   - qualquer outro id vai pelo slot gerenciado, que é o mesmo caminho da
 *     produção: `API_LLM_PROVIDER_MODEL` + a chave do provedor. Com o default
 *     do repo isso resolve para deepseek-v4-flash na Fireworks.
 *
 * NOTA DE METODOLOGIA que vale repetir aqui: assinatura e API são regimes de
 * cota diferentes (a primeira tem teto por período, a segunda rate limit por
 * minuto). Resultado que misture os dois caminhos precisa declarar isso.
 */
const MODELO = process.env.RECALL_MODEL || 'gpt-5.6-sol';

function buildModel(modelId = MODELO, options = {}) {
    const id = String(modelId).replace(/@sub$/, '');
    const porAssinatura = /@sub$/.test(String(modelId)) || /^gpt-5\.\d+-(sol|terra)$/.test(id);

    if (porAssinatura) {
        const { buildCodexSubscriptionModel } = require('@libs/llm/codex-subscription-model');
        return buildCodexSubscriptionModel(id);
    }
    // Um id do TIER0 traz baseURL e nome da chave junto; sem `applyModelEnv` o
    // slot gerenciado cai no default do repo e tenta autenticar na Fireworks
    // com a chave de outro provedor — o erro que sai e "api key is invalid",
    // que parece chave errada e nao configuracao faltando.
    const { TIER0, applyModelEnv } = require('../shared/tier0-models');
    // Claude por assinatura (Agent SDK): a fachada de 1 turno, so texto.
    if (TIER0[modelId]?.provider === 'claude_agent_sdk') {
        return require('./claude-sdk-runner').modeloFachada(TIER0[modelId].sdkModel, { effort: process.env.RECALL_REASONING_EFFORT || undefined });
    }
    // API nativa como no BYOK da nuvem (modulo 'openai' do registro -> Responses
    // API), igual a geracao em agent-provider.js: o slot gerenciado mandaria a
    // chave OpenAI como openai_compatible (/v1/chat/completions), onde o
    // gpt-6-sol recusa ferramentas com reasoning_effort.
    const spec = TIER0[modelId];
    if (spec && spec.byokNative) {
        const { REGISTRY } = require('../../libs/llm/providers/index.ts');
        const apiKey = spec.keyEnvs.map((e) => process.env[e]).find(Boolean);
        if (!apiKey) throw new Error(`no API key for ${modelId} — set one of ${spec.keyEnvs.join('/')}`);
        return REGISTRY.get(spec.provider).build({ provider: spec.provider, model: spec.doModel || id, apiKey }, options);
    }
    if (spec && spec.openrouterProviderOrder?.length) return modeloOpenRouterFixo(modelId, options);
    if (TIER0[modelId]) applyModelEnv(String(modelId));

    const { buildEvalModel } = require('../shared/build-model');
    // O slot gerenciado lê o id de API_LLM_PROVIDER_MODEL; com 'auto' ele cai
    // no default do repo. Passar o override explícito evita depender de qual
    // dos dois está preenchido.
    return buildEvalModel(options, id === 'managed' || TIER0[modelId] ? undefined : id);
}

// OpenRouter preso ao provider do id: o slot BYOK `open_router` que a producao
// monta, com o pin que ela passa por chamada (providerOptions.openrouter.provider,
// libs/llm/reasoning-options.ts). Sem ele a OpenRouter roteia cada chamada para
// um provider diferente.
function modeloOpenRouterFixo(modelId, options = {}) {
    const spec = require('../shared/tier0-models').TIER0[modelId];
    const apiKey = spec.keyEnvs.map((e) => process.env[e]).find(Boolean);
    if (!apiKey) throw new Error(`no API key for ${modelId} — set one of ${spec.keyEnvs.join('/')}`);
    const { storedByokConfig } = require('../shared/model-route');
    const { resolveModelSlot } = require('../../libs/llm/resolve-model-slot.ts');
    const { buildModelFromSlot } = require('../../libs/llm/byok-to-vercel.ts');
    const config = storedByokConfig({ provider: spec.provider, model: spec.doModel || modelId, apiKey, baseURL: spec.baseURL, openrouterProviderOrder: spec.openrouterProviderOrder });
    const { wrapLanguageModel } = require('ai');
    const pin = { order: spec.openrouterProviderOrder, allow_fallbacks: false };
    return wrapLanguageModel({
        model: buildModelFromSlot(resolveModelSlot(config, 'eval-model'), options),
        middleware: {
            transformParams: async ({ params }) => {
                const or = params.providerOptions?.openrouter || {};
                return { ...params, providerOptions: { ...params.providerOptions, openrouter: { ...or, provider: { ...(or.provider || {}), ...pin } } } };
            },
        },
    });
}

const descreveModelo = (modelId = MODELO) =>
    /@sub$/.test(String(modelId)) ? `${modelId} (assinatura)` : `${modelId} (API)`;

module.exports = { buildModel, descreveModelo, modeloOpenRouterFixo, MODELO };
