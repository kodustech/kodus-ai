#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: verify por premissas checadas as cegas, sobre a fila do corte de 65%.
 *
 * As 3 primeiras de cada PR passam direto. Para as demais:
 *   1. extracao (uma chamada one-shot por PR, com o diff): ate 3 condicoes
 *      NECESSARIAS para cada bug existir, cada uma como pergunta de sim/nao em que
 *      "sim" sustenta o bug;
 *   2. resposta as cegas: uma sessao nova por premissa, com ferramentas (e o diff),
 *      que ve so a pergunta, nunca a sugestao. "no" so vale com o codigo citado
 *      conferido lexicamente no arquivo do head;
 *   3. regra fixa: a sugestao cai se alguma premissa for refutada (E logico).
 * Tudo no modelo do cenario; Claude por assinatura roda as sessoes pelo Agent SDK.
 *
 *   RECALL_MODEL=<id> node verify-premissas.js --fila=<arq> --fusao=<arq> --pool=<orig> --out=arq.json
 * Saida no formato do verify-etapa3.js (decisoes[rep].v1.keep), lida pelo etapa3-placar.py.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { chamadaEstruturada, extraiJson } = require('./eval-structured');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const { TIER0 } = require('../shared/tier0-models');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const Q = JSON.parse(fs.readFileSync(arg('fila'), 'utf8'));
const F = JSON.parse(fs.readFileSync(arg('fusao'), 'utf8')).prs;
const POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '3'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const MODELO = process.env.RECALL_MODEL;
const PELO_SDK = TIER0[MODELO]?.provider === 'claude_agent_sdk';
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const TOPO = 3, TETO = 4, MAX_PREMISSAS = 3;

// ---------- 1. extracao ----------
const SCHEMA_EXTRACAO = {
    type: 'object',
    properties: {
        itens: {
            type: 'array',
            items: {
                type: 'object',
                properties: { indice: { type: 'number' }, premissas: { type: 'array', items: { type: 'string' } } },
                required: ['indice', 'premissas'],
                additionalProperties: false,
            },
        },
    },
    required: ['itens'],
    additionalProperties: false,
};
const extracaoTool = tool({ description: 'Record the premises of every finding. Call exactly once.', inputSchema: jsonSchema(SCHEMA_EXTRACAO), execute: async () => ({ output: 'ok' }) });
const promptExtracao = (itens, diff) => `Below are a pull request diff and code review findings about it. For each finding, write the conditions that MUST all be true about the code for the defect it describes to exist.

<Diff>
${diff}
</Diff>

<Findings>
${itens.map((c, i) => `[${i}] ${c.file}:${c.ini ?? '?'}-${c.fim ?? '?'}\n    ${String(c.texto || '').slice(0, 1500)}`).join('\n\n')}
</Findings>

Rules for the conditions:
- At most ${MAX_PREMISSAS} per finding. Only NECESSARY conditions: if any of them is false, the defect cannot happen. Leave out details that do not decide whether the defect exists.
- Each is a yes/no question about the code that can be checked by reading the repository, where YES means the defect holds. Phrase negative facts so that YES still supports the defect (write "Is there no validation of x before line 46?", not "Is x validated before line 46?").
- Self-contained: name the file, the line or function and the identifiers, so it can be answered without seeing the finding. Do not mention the finding or the reviewer.
- Cover, when they apply: that the code does what the finding says; that the triggering state can actually occur (a real caller, input or path reaches it); that nothing else already prevents the failure.

Call the tool once with an entry for every finding index.`;

// ---------- 2. resposta as cegas ----------
const SUBMIT = {
    type: 'object',
    properties: {
        answer: { type: 'string', enum: ['yes', 'no', 'unknown'] },
        evidence: {
            type: 'object',
            description: 'The code that decides the answer, copied exactly from a file you read (without line numbers).',
            properties: { file: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' }, code: { type: 'string' } },
            required: ['file', 'startLine', 'endLine', 'code'],
        },
        reason: { type: 'string' },
    },
    required: ['answer', 'reason'],
};
const SYSTEM_RESPOSTA = `You answer ONE yes/no question about a code repository, at the head of a pull request. Read the code before answering.

- yes: the code shows the statement is true.
- no: the code shows the statement is false. You MUST give the evidence: the file, lines and exact code that show it.
- unknown: you could not settle it from the code within your steps.

Answer only the question. Do not judge anything else.`;
const promptResposta = (pergunta, diff) => `<PullRequestDiff>
${diff}
</PullRequestDiff>

Question: ${pergunta}

You have up to ${TETO} steps; the last one is your answer.`;

function ferramentas(cmd) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => { try { return String(await cmd.grep(pattern, p, glob)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { try { const t = String(await cmd.read(p, startLine, endLine)); const b = Number(startLine) > 0 ? Number(startLine) : 1; return t.split('\n').map((l, k) => `${b + k}: ${l}`).join('\n').slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
    };
}

async function respondeAiSdk(model, cmd, pergunta, diff) {
    let enviado = null;
    const tools = { ...ferramentas(cmd), submitAnswer: tool({ description: 'Submit your answer. The only way to answer.', inputSchema: jsonSchema(SUBMIT), execute: async (x) => { enviado = x; return 'recorded'; } }) };
    const r = await generateText({
        model, system: SYSTEM_RESPOSTA, prompt: promptResposta(pergunta, diff) + '\nSubmit with submitAnswer.', tools,
        stopWhen: (x) => !!enviado || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submitAnswer'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submitAnswer' } }),
                messages: [...messages, { role: 'user', content: 'Final step: submit your answer now. If you could not settle it, answer unknown.' }] }
            : undefined,
    });
    return { dados: enviado || extraiJson(r.text || ''), passos: r.steps?.length ?? 0 };
}

async function respondeSdk(dir, pergunta, diff) {
    const { carregaSdk, envDoProcesso } = require('./claude-sdk-runner');
    const sdk = await carregaSdk();
    let saida = '', turnos = 0;
    try {
        for await (const msg of sdk.query({
            prompt: promptResposta(pergunta, diff) + `\nEnd your answer with ONLY a JSON object, no code fence: {"answer":"yes|no|unknown","evidence":{"file":"...","startLine":0,"endLine":0,"code":"..."},"reason":"..."}`,
            options: {
                model: TIER0[MODELO].sdkModel,
                systemPrompt: SYSTEM_RESPOSTA + '\n\nRead the repository with the Read, Grep and Glob tools; your working directory is the repository at the pull request head.',
                tools: ['Read', 'Grep', 'Glob'], allowedTools: ['Read', 'Grep', 'Glob'],
                disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
                settingSources: [], cwd: dir, maxTurns: TETO, env: envDoProcesso(),
            },
        })) {
            if (msg.type === 'assistant') { turnos++; for (const b of msg.message.content || []) if (b.type === 'text') saida += b.text + '\n'; }
            if (msg.type === 'result' && msg.result) saida += '\n' + msg.result;
        }
    } catch (e) { if (!saida) throw e; }
    return { dados: extraiJson(saida), passos: turnos };
}

// Checagem lexica da evidencia: o trecho existe no arquivo, nas linhas citadas (+-10)?
const limpa = (t) => String(t || '').replace(/^\s*\d+\s*[:|]\s?/, '').replace(/^[+-](?![+-])/, '').replace(/\s+/g, '');
function confere(dir, todos, ev) {
    if (!ev || !ev.file || !ev.code) return false;
    let rel = String(ev.file).replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (path.isAbsolute(ev.file) && ev.file.startsWith(dir)) rel = path.relative(dir, ev.file);
    let abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) {
        const achou = todos.filter((f) => f === rel || f.endsWith('/' + rel));
        if (achou.length !== 1) return false;
        abs = path.join(dir, achou[0]);
    }
    const linhas = fs.readFileSync(abs, 'utf8').split('\n');
    const ini = Math.max(0, (Number(ev.startLine) || 1) - 11), fim = Math.min(linhas.length, (Number(ev.endLine) || Number(ev.startLine) || linhas.length) + 10);
    const janela = linhas.slice(ini, fim).map(limpa).join('');
    const pedacos = String(ev.code).split(/\n|\.\.\.|…/).map(limpa).filter(Boolean);
    if (pedacos.join('').length < 10) return false;
    let pos = 0;
    for (const p of pedacos) { const k = janela.indexOf(p, pos); if (k < 0) return false; pos = k + p.length; }
    return true;
}

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify-premissas] ${descreveModelo(MODELO)} · topo ${TOPO} · teto ${TETO}${PELO_SDK ? ' · Agent SDK' : ''}`);
    const vars = {}, diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) { vars[v.caseId] = v; diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n'); }
        } catch {}
    }
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, variante: 'premissas', prs: {} };
    const fila = Object.keys(Q).filter((c) => (!SO.length || SO.includes(c)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const reps = Q[cid] || [];
            const decis = {};
            for (const r of reps.slice(0, TOPO)) decis[r] = { v1: { keep: true, leuCitado: true, garantido: true, passos: 0 } };
            const alvos = reps.slice(TOPO);
            if (alvos.length) {
                const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
                const textoDe = Object.fromEntries(F[cid].itens.map((it) => [it.rep, it.texto || cs[it.rep].suggestionContent]));
                const itens = alvos.map((r) => ({ file: cs[r].relevantFile, ini: cs[r].relevantLinesStart, fim: cs[r].relevantLinesEnd, texto: textoDe[r] }));
                const ex = await retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'premissas', schema: SCHEMA_EXTRACAO, toolDef: extracaoTool, prompt: promptExtracao(itens, diffs[cid]) }));
                const prem = Object.fromEntries((ex.dados?.itens || []).map((x) => [Number(x.indice), (x.premissas || []).filter(Boolean).slice(0, MAX_PREMISSAS)]));
                h = await prepareRepo(vars[cid], `${cid}-pm-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                let todos = [];
                try { todos = execFileSync('git', ['-C', h.dir, 'ls-files'], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n'); } catch {}
                const tarefas = alvos.flatMap((r, j) => (prem[j] || []).map((q, n) => ({ r, n, q })));
                const respostas = {};
                let t = 0;
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (t < tarefas.length) {
                        const tk = tarefas[t++];
                        const out = await retry(() => (PELO_SDK ? respondeSdk(h.dir, tk.q, diffs[cid]) : respondeAiSdk(model, cmd, tk.q, diffs[cid])));
                        const d = out.dados || {};
                        const ans = ['yes', 'no', 'unknown'].includes(d.answer) ? d.answer : 'unknown';
                        const prova = ans === 'no' ? confere(h.dir, todos, d.evidence) : null;
                        (respostas[tk.r] = respostas[tk.r] || [])[tk.n] = { pergunta: tk.q, answer: ans, provaConfere: prova, reason: String(d.reason || '').slice(0, 300), passos: out.passos };
                    }
                }));
                alvos.forEach((r, j) => {
                    const rs = (respostas[r] || []).filter(Boolean);
                    const refutada = rs.some((x) => x.answer === 'no' && x.provaConfere);
                    decis[r] = { v1: { keep: !refutada, leuCitado: true, semPremissas: !(prem[j] || []).length, premissas: rs } };
                });
            }
            res.prs[cid] = { decisoes: decis };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const ds = ok.flatMap((p) => Object.values(p.decisoes)).filter((d) => !d.v1.garantido);
    const ps = ds.flatMap((d) => d.v1.premissas || []);
    const ans = {}; for (const x of ps) ans[x.answer] = (ans[x.answer] || 0) + 1;
    console.log(JSON.stringify({ prs: ok.length, erros: Object.keys(res.prs).length - ok.length, verificadas: ds.length, derrubadas: ds.filter((d) => !d.v1.keep).length, semPremissas: ds.filter((d) => d.v1.semPremissas).length, premissas: ps.length, respostas: ans, noSemProva: ps.filter((x) => x.answer === 'no' && !x.provaConfere).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
