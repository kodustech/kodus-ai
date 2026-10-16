/**
 * Mede tokens e tempo de uma etapa do eval por unidade de trabalho (um PR),
 * mesmo com varias unidades em paralelo: cada `medir(fn)` abre um contador
 * proprio no AsyncLocalStorage, e toda chamada de modelo feita dentro de `fn`
 * soma nele.
 *
 * Duas portas de entrada para a usage:
 *   - `instalaNoLLM()`: envolve o LlmObservability, entao cada `LLM.run`
 *     (dedup) soma sozinho, sem mexer no chamador. Preserva o observability ja
 *     registrado (Langfuse do eval), se houver.
 *   - `registra(usage)`: para quem chama o AI SDK direto (generateText) ou o
 *     Agent SDK; aceita os formatos que aparecem no repo.
 *
 *   const { medir, registra, instalaNoLLM } = require('../../shared/usage-meter');
 *   const { valor, uso } = await medir(() => trabalhoDoPr());
 *   // uso = { chamadas, input, cacheRead, output, reasoning, ms }
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const zero = () => ({ chamadas: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0 });

/** Soma uma usage no contador da unidade atual. AI SDK 7 (inputTokenDetails),
 *  o campo legado (cachedInputTokens), o formato ja normalizado do eval
 *  (cacheReadTokens) e o do Agent SDK (input_tokens / cache_read_input_tokens). */
function registra(u) {
    const c = als.getStore();
    if (!c || !u) return;
    const cache = u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? u.cacheReadTokens ?? u.cache_read_input_tokens ?? 0;
    // O Agent SDK conta o input sem o cache; os demais ja incluem o cache no input.
    const input = u.inputTokens ?? (u.input_tokens != null ? u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0);
    c.chamadas++;
    c.input += input || 0;
    c.cacheRead += cache || 0;
    c.output += u.outputTokens ?? u.output_tokens ?? 0;
    c.reasoning += u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens ?? 0;
}

/** Roda `fn` com um contador proprio; devolve o valor e a usage com o tempo de parede. */
async function medir(fn) {
    const c = zero();
    const t0 = Date.now();
    const valor = await als.run(c, fn);
    return { valor, uso: { ...c, ms: Date.now() - t0 } };
}

let instalado = false;
/** Faz cada LLM.run somar no contador da unidade atual. */
function instalaNoLLM() {
    if (instalado) return;
    instalado = true;
    const { getLlmObservability, setLlmObservability } = require('@libs/llm/llm-observability');
    const anterior = getLlmObservability();
    setLlmObservability({
        async runAiSdkLLMInSpan(params) {
            const exec = async () => {
                const r = await params.exec();
                registra(r?.usage);
                return r;
            };
            return anterior ? anterior.runAiSdkLLMInSpan({ ...params, exec }) : exec();
        },
    });
}

/** Soma uma lista de usos (para totais por etapa). */
function soma(usos) {
    const t = { ...zero(), ms: 0 };
    for (const u of usos) if (u) for (const k of Object.keys(t)) t[k] += u[k] || 0;
    return t;
}

module.exports = { medir, registra, instalaNoLLM, soma };
