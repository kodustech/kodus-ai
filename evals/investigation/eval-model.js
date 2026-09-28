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
    if (TIER0[modelId]) applyModelEnv(String(modelId));

    const { buildEvalModel } = require('../shared/build-model');
    // O slot gerenciado lê o id de API_LLM_PROVIDER_MODEL; com 'auto' ele cai
    // no default do repo. Passar o override explícito evita depender de qual
    // dos dois está preenchido.
    return buildEvalModel(options, id === 'managed' || TIER0[modelId] ? undefined : id);
}

const descreveModelo = (modelId = MODELO) =>
    /@sub$/.test(String(modelId)) ? `${modelId} (assinatura)` : `${modelId} (API)`;

module.exports = { buildModel, descreveModelo, MODELO };
