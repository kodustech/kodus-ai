/**
 * Chamada estruturada dos scripts offline, respeitando o modelo.
 *
 * `generateText` + `toolChoice: { type: 'tool' }` devolve 400 Bad Request em
 * modelo always-thinking (Kimi K2.7 Code, Kimi K3, Sonnet 5.5): ferramenta
 * forcada e thinking sao incompativeis e esses modelos nao aceitam desligar o
 * thinking. Medido em 29/09: os 10 PRs das quatro pools do Kimi abortaram no
 * atribuidor com "Bad Request", e o reducer inteiro devolveu zero grupos.
 *
 * `planStructuredCall` ja e a decisao unica que a producao usa (LLM.run ->
 * structured-review-call). Aqui os scripts offline passam pela mesma decisao:
 *   - 'as-is' / 'suppress-thinking' -> ferramenta forcada, como antes.
 *   - 'reroute-json'                -> sem ferramenta; o schema vai no prompt e
 *                                      o JSON volta no texto.
 */
const {
    planStructuredCall,
    resolveCompatibleReasoningTraits,
} = require('../../libs/llm/providers/kernel/reasoning-traits.ts');

/** O id limpo (sem sufixo de rota) que o resolvedor de traits entende. */
const idLimpo = (modelId) =>
    String(modelId || process.env.RECALL_MODEL || '')
        .replace(/@[a-z0-9_-]+$/i, '');

function plano(modelId) {
    // A fachada do Agent SDK nao faz chamada de ferramenta: JSON no texto.
    if (require('../shared/tier0-models').TIER0[modelId || process.env.RECALL_MODEL || '']?.provider === 'claude_agent_sdk') return 'reroute-json';
    return planStructuredCall(
        undefined,
        resolveCompatibleReasoningTraits(idLimpo(modelId)),
    );
}

/** Ultimo objeto JSON balanceado do texto (o modelo pensa antes e escreve
 *  depois; pegar o PRIMEIRO `{` costuma cair num trecho do raciocinio). */
function extraiJson(texto) {
    const t = String(texto || '').replace(/```(?:json)?/gi, '');
    for (let fim = t.length; fim > 0; fim--) {
        if (t[fim - 1] !== '}') continue;
        let nivel = 0;
        for (let i = fim - 1; i >= 0; i--) {
            if (t[i] === '}') nivel++;
            else if (t[i] === '{' && --nivel === 0) {
                try {
                    return JSON.parse(t.slice(i, fim));
                } catch {
                    break;
                }
            }
        }
    }
    return null;
}

/**
 * @param {object} p
 * @param {any}    p.model      modelo ja construido (buildModel)
 * @param {string} p.modelId    id textual, para decidir o plano
 * @param {string} p.nome       nome da ferramenta / rotulo do JSON
 * @param {object} p.schema     JSON Schema cru do resultado
 * @param {string} p.prompt
 * @param {object} [p.extra]    campos extras do generateText (telemetria etc.)
 * @param {any}    [p.toolDef]  a ferramenta ja montada, para a rota com tool
 * @returns {Promise<{dados: any, usage: any, via: string}>}
 */
async function chamadaEstruturada({ model, modelId, nome, schema, prompt, extra = {}, toolDef }) {
    const { generateText, tool, jsonSchema } = require('ai');
    const via = plano(modelId);

    if (via === 'reroute-json') {
        const r = await generateText({
            ...extra,
            model,
            prompt: `${prompt}\n\nReturn ONLY a JSON object matching this schema. No prose, no code fence, nothing after the closing brace.\n${JSON.stringify(schema)}`,
        });
        const dados = extraiJson(r.text);
        if (!dados) throw new Error('resposta sem JSON parseavel');
        return { dados, usage: r.usage, via };
    }

    const t =
        toolDef ||
        tool({
            description: `Registra o resultado. Chame exatamente uma vez.`,
            inputSchema: jsonSchema(schema),
            execute: async () => ({ output: 'ok' }),
        });
    let r;
    try {
        r = await generateText({
            ...extra,
            model,
            tools: { [nome]: t },
            toolChoice: { type: 'tool', toolName: nome },
            prompt,
        });
    } catch (e) {
        // Muse (Meta) so aceita tool_choice "auto": a ferramenta continua sendo
        // a unica saida, so que sem forcar pelo nome.
        if (!/tool_choice|tool choice/i.test(String(e?.message ?? ''))) throw e;
        r = await generateText({
            ...extra,
            model,
            tools: { [nome]: t },
            toolChoice: 'auto',
            prompt: `${prompt}\n\nAnswer by calling ${nome} exactly once.`,
        });
    }
    const call = (r.toolCalls || []).find((c) => (c.toolName ?? c.name) === nome);
    return { dados: (call?.input ?? call?.args) || {}, usage: r.usage, via };
}

module.exports = { chamadaEstruturada, plano, extraiJson };
