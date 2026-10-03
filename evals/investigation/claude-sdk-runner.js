/**
 * #1821: AgentRunner que roda cada passada do harness (G, S, lentes, verify)
 * pelo Claude Agent SDK, pela ASSINATURA (token de `claude setup-token`).
 *
 * O SDK e dono do loop, entao a passada vira uma `query()` com o system
 * prompt do spec e as tools do spec expostas por MCP in-process. O que o
 * runner de producao faz por step e nao cabe aqui:
 *   - ForceFinalize / ForceTextFinalize: emulados em duas fases. A fase 1 roda
 *     ate `maxSteps - within` turnos com todas as tools; se estourar, a fase 2
 *     retoma a sessao com a mesma nota que a policy injetaria (e, no
 *     ForceFinalize, so a tool de submit liberada).
 *   - CompletionGate (nota de divida por step) e Compression: nao reproduzidos.
 *
 * Fica fora do repo de proposito o pacote do SDK: RECALL_CLAUDE_SDK_DIR aponta
 * para uma pasta com `@anthropic-ai/claude-agent-sdk` instalado.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SERVER = 'bench';
const PREFIXO = `mcp__${SERVER}__`;

let sdkPromise;
function carregaSdk() {
    if (!sdkPromise) {
        const dir = process.env.RECALL_CLAUDE_SDK_DIR;
        if (!dir) throw new Error('RECALL_CLAUDE_SDK_DIR nao definido (pasta com @anthropic-ai/claude-agent-sdk)');
        const req = require('module').createRequire(path.join(dir, 'package.json'));
        const entrada = req.resolve('@anthropic-ai/claude-agent-sdk');
        sdkPromise = Promise.all([
            import(pathToFileURL(entrada).href),
            import(pathToFileURL(req.resolve('zod')).href),
        ]).then(([sdk, zod]) => ({ ...sdk, z: zod.z || zod.default || zod }));
    }
    return sdkPromise;
}

// Cada query sobe um processo do Claude Code; sem teto, um PR com 20 passadas
// e dezenas de verifies abre centenas de processos ao mesmo tempo.
class Semaforo {
    constructor(n) { this.livres = n; this.fila = []; }
    async pega() {
        if (this.livres > 0) { this.livres--; return; }
        await new Promise((r) => this.fila.push(r));
    }
    solta() {
        const prox = this.fila.shift();
        if (prox) prox(); else this.livres++;
    }
}
const semaforo = new Semaforo(Number(process.env.RECALL_CLAUDE_SDK_MAX_PAR || 24));

function envDoProcesso() {
    const token = fs.readFileSync(process.env.RECALL_CLAUDE_OAUTH_FILE || path.join(os.homedir(), '.claude-oauth'), 'utf8').trim();
    const fora = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_OAUTH_TOKEN']);
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !fora.has(k)));
    env.CLAUDE_CODE_OAUTH_TOKEN = token;
    // Sem as chamadas paralelas do CLI (titulo de sessao etc.) que cairiam no Haiku.
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    return env;
}

function shapeDe(z, schema) {
    try {
        const t = z.fromJSONSchema(schema || { type: 'object', properties: {} });
        if (t && t.shape) return t.shape;
    } catch {}
    // Schema que o conversor nao entende: aceita qualquer campo e deixa a
    // validacao para o execute() da tool, como no runner de producao.
    const props = (schema && schema.properties) || {};
    return Object.fromEntries(Object.keys(props).map((k) => [k, z.any().describe(props[k]?.description || k)]));
}

function textoDe(content) {
    if (typeof content === 'string') return content;
    return (content || []).map((c) => (c.type === 'text' ? c.text : '')).join('');
}

/** Ultimo objeto JSON do texto (com ou sem cerca); array solto vira {suggestions}. */
function jsonDoTexto(texto) {
    const cerca = [...String(texto).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
    const candidatos = [...cerca.reverse(), String(texto)];
    for (const c of candidatos) {
        for (const ini of ['{', '[']) {
            const i = c.indexOf(ini);
            if (i < 0) continue;
            const fimc = ini === '{' ? c.lastIndexOf('}') : c.lastIndexOf(']');
            try {
                const v = JSON.parse(c.slice(i, fimc + 1));
                if (Array.isArray(v)) return { suggestions: v };
                if (v && Array.isArray(v.suggestions)) return v;
            } catch {}
        }
    }
    return null;
}

/** Nota e tools que a policy de finalizacao imporia no passo `step`. */
function diretivaFinal(spec, step) {
    for (const p of spec.policies || []) {
        if (!['force-finalize', 'force-text-finalize'].includes(p.name)) continue;
        const d = p.prepareStep({ stepNumber: step, maxSteps: spec.maxSteps, messages: [], activeTools: [] });
        if (d && d.injectNote) return { nota: textoDe(d.injectNote.content), tools: d.activeTools, within: spec.maxSteps - step };
    }
    return null;
}

function inicioDaFinalizacao(spec) {
    for (let s = 0; s < spec.maxSteps; s++) if (diretivaFinal(spec, s)) return s;
    return spec.maxSteps;
}

class ClaudeSdkRunner {
    constructor(modelId, opts = {}) {
        this.modelId = modelId;
        this.effort = opts.effort;
        this.timeoutMs = opts.timeoutMs || 20 * 60 * 1000;
        this.cwd = opts.cwd;
    }

    async run(spec, input, ctx) {
        // Captura (#1821, d0 pela CLI): grava o system e o prompt exatos da
        // passada e devolve uma passada vazia, sem chamar o modelo.
        const cap = process.env.RECALL_CLAUDE_SDK_CAPTURE_DIR;
        if (cap) {
            fs.mkdirSync(cap, { recursive: true });
            fs.writeFileSync(path.join(cap, `${path.basename(this.cwd || 'sem-repo')}-${spec.id}.json`),
                JSON.stringify({ cwd: this.cwd, system: spec.systemPrompt, prompt: input.prompt }));
            return { runId: ctx?.runId || 'captura', agentId: spec.id, status: 'completed', steps: [], artifacts: [], usage: {}, trace: [] };
        }
        const sdk = await carregaSdk();
        const { z } = sdk;
        // Escada do #1821 (so o G): cada botao desfaz uma diferenca entre o
        // nosso loop e o Claude Code puro. Desligados = a config da superset.
        // Os botoes valem so para o finder; o verificador roda sempre na config
        // da superset. RECALL_CLAUDE_SDK_NOCAP_ACIMA=N tira o teto so das
        // passadas com maxSteps > N (G e S tem 12; as lentes, 1 e 3).
        const finder = spec.id === 'finder';
        const acima = Number(process.env.RECALL_CLAUDE_SDK_NOCAP_ACIMA || 0);
        const esc = {
            preset: finder && process.env.RECALL_CLAUDE_SDK_PRESET === '1',
            ccTools: finder && process.env.RECALL_CLAUDE_SDK_CC_TOOLS === '1',
            // As lentes (passadas com teto) mantem a tool de submit: o prompt
            // delas manda chamar submitResult, e sem a tool o modelo chama
            // assim mesmo e gasta um passo no erro.
            submit: !finder || process.env.RECALL_CLAUDE_SDK_SUBMIT !== '0' || (acima > 0 && spec.maxSteps <= acima),
            semTeto: finder && process.env.RECALL_CLAUDE_SDK_NOCAP === '1' && spec.maxSteps > acima,
        };
        const todas = spec.tools.list().filter((t) =>
            esc.ccTools ? esc.submit && t.name === spec.resultToolName : esc.submit || t.name !== spec.resultToolName,
        );
        const mcp = sdk.createSdkMcpServer({
            name: SERVER,
            version: '1',
            tools: todas.map((t) =>
                sdk.tool(t.name, t.description || t.name, shapeDe(z, t.inputSchema), async (args) => {
                    try {
                        const r = await t.execute(args, ctx);
                        return { content: [{ type: 'text', text: String(r.output ?? '') }], isError: !!r.isError };
                    } catch (e) {
                        return { content: [{ type: 'text', text: `Tool error: ${e?.message || e}` }], isError: true };
                    }
                }, { alwaysLoad: true }),
            ),
        });
        const nomesMcp = todas.map((t) => PREFIXO + t.name);

        const passos = new Map(); // message.id -> step
        const ordem = [];
        const saidas = new Map(); // tool_use_id -> {output,isError}
        const uso = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        let sessao;
        let fim;

        const consome = async (prompt, opcoes) => {
            let recebeuResultado = false;
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), this.timeoutMs);
            await semaforo.pega();
            try {
                const dump = process.env.RECALL_CLAUDE_SDK_DUMP_DIR;
                const arq = dump ? path.join(dump, `${spec.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jsonl`) : null;
                if (arq) {
                    fs.mkdirSync(dump, { recursive: true });
                    fs.appendFileSync(arq, JSON.stringify({ prompt, allowedTools: opcoes.allowedTools, maxTurns: opcoes.maxTurns, resume: !!opcoes.resume }) + '\n');
                }
                for await (const m of sdk.query({ prompt, options: { ...opcoes, abortController: ac } })) {
                    if (arq) fs.appendFileSync(arq, JSON.stringify(m) + '\n');
                    if (m.type === 'system' && m.subtype === 'init') sessao = m.session_id;
                    else if (m.type === 'assistant') {
                        const id = m.message.id || `m${ordem.length}`;
                        let p = passos.get(id);
                        if (!p) {
                            p = { texto: '', toolCalls: [], usage: m.message.usage };
                            passos.set(id, p);
                            ordem.push(id);
                        }
                        for (const c of m.message.content || []) {
                            if (c.type === 'text') p.texto += c.text;
                            else if (c.type === 'tool_use') {
                                p.toolCalls.push({ id: c.id, name: c.name.startsWith(PREFIXO) ? c.name.slice(PREFIXO.length) : c.name, input: c.input });
                            }
                        }
                    } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
                        for (const c of m.message.content) {
                            if (c.type === 'tool_result') saidas.set(c.tool_use_id, { output: textoDe(c.content), isError: !!c.is_error });
                        }
                    } else if (m.type === 'result') {
                        fim = m;
                        recebeuResultado = true;
                        const mu = (m.modelUsage || {})[Object.keys(m.modelUsage || {}).find((k) => k.startsWith(this.modelId)) || ''] ;
                        if (mu) {
                            const cr = mu.cacheReadInputTokens || 0, cw = mu.cacheCreationInputTokens || 0;
                            uso.inputTokens += (mu.inputTokens || 0) + cr + cw;
                            uso.outputTokens += mu.outputTokens || 0;
                            uso.cacheReadTokens += cr;
                            uso.cacheWriteTokens += cw;
                        }
                    }
                }
            } catch (e) {
                // Turno maximo atingido: o SDK entrega o `result` e depois o
                // processo do Claude Code sai com codigo 1, que vira excecao.
                if (!recebeuResultado) throw e;
            } finally {
                clearTimeout(timer);
                semaforo.solta();
            }
        };

        const ferramentasCc = ['Read', 'Grep', 'Glob', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'];
        if (esc.ccTools) nomesMcp.push(...ferramentasCc);
        const base = {
            model: this.modelId,
            systemPrompt: esc.preset ? { type: 'preset', preset: 'claude_code', append: spec.systemPrompt } : spec.systemPrompt,
            tools: esc.ccTools ? ['Read', 'Grep', 'Glob', 'Bash'] : [],
            ...(todas.length ? { mcpServers: { [SERVER]: mcp } } : {}),
            ...(esc.ccTools ? { disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'] } : {}),
            settingSources: [],
            cwd: esc.ccTools && this.cwd ? this.cwd : os.tmpdir(),
            env: envDoProcesso(),
            ...(this.effort ? { effort: this.effort } : {}),
        };
        const semente = (input.seedMessages || []).map((m) => `${m.role}: ${m.content}`).join('\n\n');
        const prompt = semente ? `${semente}\n\n${input.prompt}` : input.prompt;

        const corte = inicioDaFinalizacao(spec);
        const submeteu = () => !!spec.resultToolName && ordem.some((id) => passos.get(id).toolCalls.some((tc) => tc.name === spec.resultToolName));
        let erro;
        try {
            if (esc.semTeto) {
                await consome(prompt, { ...base, allowedTools: nomesMcp });
            } else if (corte > 0) {
                await consome(prompt, { ...base, allowedTools: nomesMcp, maxTurns: corte });
            }
            const estourou = corte === 0 || fim?.subtype === 'error_max_turns';
            // Claude costuma fechar a passada com o achado em TEXTO, sem chamar
            // o submit. No runner de producao isso cai na recuperacao de prosa
            // (outra chamada de modelo); aqui o proprio modelo e chamado a
            // submeter o que acabou de escrever, com a nota do ForceFinalize.
            const forcaSubmit = (spec.policies || []).some((p) => p.name === 'force-finalize');
            const fechouEmTexto = esc.submit && forcaSubmit && !estourou && ordem.length > 0;
            if (!esc.semTeto && !submeteu() && ((estourou && ordem.length < spec.maxSteps) || fechouEmTexto)) {
                const d0 = diretivaFinal(spec, Math.max(corte, Math.min(ordem.length, spec.maxSteps - 1)));
                // Sem a tool de submit, a nota pede a resposta final em JSON no
                // texto e nenhuma tool fica liberada.
                const d = esc.submit || !d0 ? d0 : {
                    ...d0,
                    tools: [],
                    nota: 'You are at the final step. Give your final answer now, as the JSON described in the output format, with the findings you have. Do not investigate further.',
                };
                const liberadas = d?.tools ? d.tools.map((n) => PREFIXO + n) : nomesMcp;
                const opcoes = {
                    ...base,
                    allowedTools: liberadas,
                    disallowedTools: [...(base.disallowedTools || []), ...nomesMcp.filter((n) => !liberadas.includes(n))],
                    maxTurns: Math.max(1, spec.maxSteps - ordem.length),
                };
                if (corte === 0 || !sessao) await consome(`${prompt}\n\n${d?.nota || ''}`.trim(), opcoes);
                else await consome(d?.nota || 'Finish now.', { ...opcoes, resume: sessao });
            }
        } catch (e) {
            erro = e;
            console.warn(`[claude-sdk] ${spec.id} falhou: ${String(e?.message || e).slice(0, 300)}`);
        }

        const steps = ordem.map((id, index) => {
            const p = passos.get(id);
            const toolCalls = p.toolCalls.map((tc) => ({ ...tc, ...(saidas.get(tc.id) || {}) }));
            return {
                index,
                message: { role: 'assistant', content: p.texto, ...(toolCalls.length ? { toolCalls } : {}) },
            };
        });
        const artifacts = [];
        if (spec.resultToolName) {
            steps.forEach((s) => (s.message.toolCalls || []).forEach((tc) => {
                if (tc.name === spec.resultToolName) {
                    artifacts.push({ type: spec.resultToolName, payload: tc.input, location: `step:${s.index}`, stage: 'result' });
                }
            }));
        }
        // Sem a tool de submit (ou sem teto, onde nao ha finalizacao forcada),
        // a entrega e o JSON no texto final, como na config do Gabriel.
        let modoEntrega = artifacts.length ? 'tool' : 'nenhum';
        if (!artifacts.length && spec.resultToolName && (!esc.submit || esc.semTeto)) {
            const final = [...steps].reverse().find((st) => (st.message.content || '').trim());
            const payload = final ? jsonDoTexto(final.message.content) : null;
            if (payload) {
                artifacts.push({ type: spec.resultToolName, payload, location: `step:${final.index}`, stage: 'texto' });
                modoEntrega = 'texto';
            } else if (final) modoEntrega = 'falha-parse';
        }
        if (process.env.RECALL_CLAUDE_SDK_LOG) {
            const hash = (x) => require('crypto').createHash('sha256').update(String(x)).digest('hex').slice(0, 16);
            const ferramentas = {};
            steps.forEach((st) => (st.message.toolCalls || []).forEach((tc) => { ferramentas[tc.name] = (ferramentas[tc.name] || 0) + 1; }));
            fs.appendFileSync(process.env.RECALL_CLAUDE_SDK_LOG, JSON.stringify({
                spec: spec.id, esc, cwdRepo: !!(esc.ccTools && this.cwd), systemSha: hash(spec.systemPrompt), promptSha: hash(input.prompt),
                passos: steps.length, numTurns: fim?.num_turns, ferramentas, modoEntrega, fim: fim?.subtype, erro: erro ? String(erro?.message || erro).slice(0, 200) : null,
            }) + '\n');
        }
        const status = erro || fim?.is_error && fim?.subtype !== 'error_max_turns' ? 'error' : fim?.subtype === 'error_max_turns' ? 'budget-exhausted' : 'completed';
        return {
            runId: ctx?.runId || `sdk-${Date.now()}`,
            agentId: spec.id,
            status,
            steps,
            artifacts,
            stopReason: erro ? `sdk-error: ${String(erro?.message || erro).slice(0, 300)}` : fim?.subtype,
            usage: uso,
            trace: [],
        };
    }
}

/** Modelo "fachada" para as chamadas avulsas (recuperacao de prosa): uma
 *  `query()` de 1 turno, sem tools, pela mesma assinatura. O adapter tambem le
 *  `modelId` para o texto Claude-safe. */
function modeloFachada(modelId, opts = {}) {
    const gera = async (options) => {
        const sdk = await carregaSdk();
        const partes = [];
        let sistema = '';
        for (const m of options.prompt || []) {
            const t = typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join('');
            if (m.role === 'system') sistema += t + '\n';
            else partes.push(t);
        }
        const rf = options.responseFormat;
        if (rf && rf.type === 'json') {
            partes.push(`Respond with only a JSON object${rf.schema ? ` matching this JSON Schema:\n${JSON.stringify(rf.schema)}` : ''}. No prose, no code fence.`);
        }
        let texto = '';
        const uso = { inputTokens: 0, outputTokens: 0 };
        await semaforo.pega();
        try {
            for await (const m of sdk.query({ prompt: partes.join('\n\n'), options: {
                model: modelId, systemPrompt: sistema || 'You are a precise assistant.', tools: [], settingSources: [],
                maxTurns: 1, cwd: os.tmpdir(), env: envDoProcesso(), ...(opts.effort ? { effort: opts.effort } : {}),
            } })) {
                if (m.type === 'assistant') for (const c of m.message.content || []) if (c.type === 'text') texto += c.text;
                if (m.type === 'result') {
                    const mu = Object.values(m.modelUsage || {})[0] || {};
                    uso.inputTokens = (mu.inputTokens || 0) + (mu.cacheReadInputTokens || 0) + (mu.cacheCreationInputTokens || 0);
                    uso.outputTokens = mu.outputTokens || 0;
                }
            }
        } finally {
            semaforo.solta();
        }
        const t = texto.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        return {
            content: [{ type: 'text', text: t }],
            finishReason: 'stop',
            usage: { inputTokens: uso.inputTokens, outputTokens: uso.outputTokens, totalTokens: uso.inputTokens + uso.outputTokens },
            warnings: [],
        };
    };
    return {
        specificationVersion: 'v2',
        provider: 'claude-agent-sdk',
        modelId,
        supportedUrls: {},
        doGenerate: gera,
        async doStream(options) {
            const r = await gera(options);
            const text = r.content[0].text;
            return {
                stream: new ReadableStream({
                    start(c) {
                        c.enqueue({ type: 'stream-start', warnings: [] });
                        c.enqueue({ type: 'text-start', id: '0' });
                        c.enqueue({ type: 'text-delta', id: '0', delta: text });
                        c.enqueue({ type: 'text-end', id: '0' });
                        c.enqueue({ type: 'finish', finishReason: 'stop', usage: r.usage });
                        c.close();
                    },
                }),
            };
        },
    };
}

module.exports = { ClaudeSdkRunner, modeloFachada };
