/**
 * Constrói o modelo dos scripts offline a partir de `RECALL_MODEL`.
 *
 * Um id do TIER0 com `byokNative` vai pelo modulo nativo do registro; um com
 * pin da OpenRouter vai pelo slot BYOK `open_router`; qualquer outro id vai
 * pelo slot gerenciado, que é o mesmo caminho da produção:
 * `API_LLM_PROVIDER_MODEL` + a chave do provedor.
 */
const MODELO = process.env.RECALL_MODEL || 'gpt-6-sol@api';

function buildModel(modelId = MODELO, options = {}) {
    const id = String(modelId);
    // Um id do TIER0 traz baseURL e nome da chave junto; sem `applyModelEnv` o
    // slot gerenciado cai no default do repo e tenta autenticar na Fireworks
    // com a chave de outro provedor — o erro que sai e "api key is invalid",
    // que parece chave errada e nao configuracao faltando.
    const { TIER0, applyModelEnv } = require('../shared/tier0-models');
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

const descreveModelo = (modelId = MODELO) => `${modelId} (API)`;

module.exports = { buildModel, descreveModelo, modeloOpenRouterFixo, MODELO };
