#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821, etapa 3 (verify): variantes do verify sobre a fila que a etapa 2
 * publicaria (etapa2-formula.py ... <dump>), uma sessao por sugestao, com o diff
 * do PR no comeco do prompt. O texto verificado e o publicado (o mesclado do
 * dedup + v5, quando houver).
 *
 *   a10     verify de producao (keep true/false, refutar para derrubar), teto 10,
 *           com pelo menos 4 passos de investigacao antes do veredito (instrucao
 *           no prompt + as 4 primeiras chamadas so aceitam grep/readFile).
 *   seguro  verify de producao, teto 7, com duas protecoes:
 *             1. derrubar so vale se o verify leu o arquivo citado;
 *             2. o que for derrubado passa por uma segunda sessao independente e
 *                so cai se as duas derrubarem.
 *   cenario pergunta nova: demonstrar a falha (entrada/estado -> resultado
 *           errado, citando linhas). Sem cenario concreto depois de investigar, a
 *           sugestao cai. Teto 7, mesmas duas protecoes.
 *   citacao igual ao cenario, mas a derrubada traz o codigo que a justifica
 *           (arquivo, linhas, trecho copiado); uma checagem lexica confere se o
 *           trecho existe no arquivo do head, nas linhas citadas (folga de 10).
 * Em todas, a instrucao de passos do prompt diz o teto real.
 *
 *   RECALL_MODEL=<id> node verify-etapa3.js --fila=<dump> --fusao=<arq> --pool=<orig> --variante=seguro --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const { extraiJson } = require('./eval-structured');
const { buildVerifierPrompt } = require('../../libs/code-review/infrastructure/agents/prompts/verifier-prompt.ts');
const { bundleFor } = require('../../libs/code-review/infrastructure/agents/core/verifier.agent.ts');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const FILA = arg('fila'), FUSAO = arg('fusao'), POOL = arg('pool'), OUT = arg('out'), VAR = arg('variante', 'seguro'), PAR = Number(arg('par', '3'));
const MODELO = process.env.RECALL_MODEL;
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
// a10l: verify A com teto 10 e SEM minimo de passos (com as protecoes).
const TETO = VAR === 'a10' || VAR === 'a10l' ? 10 : 7;
const MIN_INVEST = VAR === 'a10' ? 4 : 0;
const PROTEGE = VAR !== 'a10';
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();
const mesmoArquivo = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.endsWith('/' + b) || b.endsWith('/' + a)); };

const PASSOS = (teto, min) => `You have up to ${teto} steps. The LAST one is your verdict — submitting is itself a step — so you have up to ${teto - 1} to investigate with.${min ? ` Use at least ${min} investigation steps (grep / readFile) before you decide: read the cited code, then the callers, guards and related code that could confirm or refute the claim.` : ''}

Recommended approach:
1. Read the cited file/range.
2. Search for the key symbol or caller if the claim depends on flow.
3. Read the relevant caller/callee files.
4. Submit your verdict with submitVerdict.`;

const PROD = buildVerifierPrompt('', 0);
const SYSTEM = {
    prod: PROD.system.replace('- You may use only a few tool calls. Be surgical.\n', ''),
    cenario: `You are checking ONE code review finding on a pull request by trying to DEMONSTRATE the failure it describes.

Use the tools to read the code and build the concrete scenario: the input, state or sequence of calls that reaches the cited code, and the wrong result that follows — a crash, a wrong value, lost or corrupted data, a security exposure, or a feature that stops working. Cite file:line for each step of the scenario.

Verdict:
- keep = true when you can state that scenario from the code you read. Concurrent, adversarial and edge-condition scenarios count, as long as the code really allows them. A defect reached through a caller in another file counts.
- keep = false when, after investigating, there is no such scenario: a guard, validation or type upstream prevents it; the path is unreachable; the claim is factually wrong about the code; or what the claim describes is true but produces no wrong outcome for any caller or user (it only restates how the code works, or is a preference about how it is written).

Do not decide from the claim's wording. Decide from the code. If you run out of steps before you can tell, keep = true.`,
};
const REFUTACAO = {
    type: 'object',
    description: 'Required when keep=false: the code you READ that prevents the failure, copied exactly from the file.',
    properties: { file: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' }, code: { type: 'string', description: 'The exact lines, copied from what readFile returned (without the line numbers).' } },
    required: ['file', 'startLine', 'endLine', 'code'],
};
const SUBMIT = {
    prod: { type: 'object', properties: { keep: { type: 'boolean' }, rationale: { type: 'string' } }, required: ['keep', 'rationale'] },
    cenario: { type: 'object', properties: { keep: { type: 'boolean' }, scenario: { type: 'string', description: 'keep=true: input/state -> wrong result, citing file:line. keep=false: what prevents it, or why there is no wrong outcome, citing file:line.' } }, required: ['keep', 'scenario'] },
};
const TIPO = VAR === 'cenario' || VAR === 'citacao' ? 'cenario' : 'prod';
const CITA = VAR === 'citacao';

function promptDe(c, diff) {
    const bundle = bundleFor(c).split('\n').filter((l) => !l.startsWith('Severity:')).join('\n');
    const pedido = CITA
        ? 'Submit with submitVerdict: {"keep": true|false, "scenario": "...", "refutation": {...}}. When keep=false, "refutation" is REQUIRED: the file, startLine, endLine and the exact code you read that prevents the failure (a guard, a validation, an early return, a type), copied from the readFile output. A keep=false without that code is not accepted.'
        : TIPO === 'cenario'
        ? 'Submit with submitVerdict: {"keep": true|false, "scenario": "..."}.'
        : 'Submit your verdict with submitVerdict: {"keep": true|false, "rationale": "why the evidence supports keep/drop"}. keep=true unless you can REFUTE it.';
    return `<PullRequestDiff>\n${diff}\n</PullRequestDiff>\n\n${bundle}\n\n${PASSOS(TETO, MIN_INVEST)}\n\n${pedido}`;
}

function ferramentas(cmd, lidos) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => { try { return String(await cmd.grep(pattern, p, glob)).slice(0, 6000); } catch (e) { return `grep failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { lidos.push(p); try { return String(await cmd.read(p, startLine, endLine)).slice(0, 12000); } catch (e) { return `readFile failed: ${String(e.message || e).slice(0, 120)}`; } },
        }),
    };
}

async function sessao(model, cmd, c, diff, dir) {
    let veredito = null;
    const lidos = [];
    const schema = CITA ? { ...SUBMIT.cenario, properties: { ...SUBMIT.cenario.properties, refutation: REFUTACAO } } : SUBMIT[TIPO];
    const tools = { ...ferramentas(cmd, lidos), submitVerdict: tool({ description: 'Submit your verdict. The only way to answer.', inputSchema: jsonSchema(schema), execute: async (x) => { veredito = x; return 'verdict recorded'; } }) };
    const r = await generateText({
        model, system: SYSTEM[TIPO], prompt: promptDe(c, diff), tools,
        stopWhen: (x) => !!veredito || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => {
            if (stepNumber >= TETO - 1) {
                return { activeTools: ['submitVerdict'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submitVerdict' } }),
                    messages: [...messages, { role: 'user', content: 'You are at the final step. Submit your verdict now, from the evidence you already have.' }] };
            }
            // Minimo de investigacao: nas primeiras chamadas so grep/readFile, e uma delas e obrigatoria.
            if (stepNumber < MIN_INVEST) return { activeTools: ['grep', 'readFile'], ...(semToolChoiceNomeado ? {} : { toolChoice: 'required' }) };
            return undefined;
        },
    });
    if (!veredito) veredito = extraiJson(r.text || '');
    const temVeredito = typeof veredito?.keep === 'boolean';
    const out = { keep: temVeredito ? veredito.keep : true, temVeredito, passos: r.steps?.length ?? 0, leuCitado: lidos.some((p) => mesmoArquivo(p, c.relevantFile)), texto: String(veredito?.rationale || veredito?.scenario || '').slice(0, 600) };
    if (CITA && out.keep === false) { out.refutacao = veredito?.refutation || null; out.citacao = confereCitacao(dir, out.refutacao); }
    return out;
}

// Checagem lexica da citacao: o trecho existe no arquivo do head, nas linhas citadas (+-10)?
const { execFileSync } = require('child_process');
const limpa = (t) => String(t || '').replace(/^\s*\d+\s*[:|]\s?/, '').replace(/^[+-](?![+-])/, '').replace(/\s+/g, '');
function confereCitacao(dir, ref) {
    if (!ref || !ref.file || !ref.code) return { ok: false, motivo: 'sem-citacao' };
    let rel = String(ref.file).replace(/\\/g, '/').replace(/^\.?\/+/, '');
    let abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) {
        let todos = [];
        try { todos = execFileSync('git', ['-C', dir, 'ls-files'], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n'); } catch {}
        const achou = todos.filter((f) => f === rel || f.endsWith('/' + rel));
        if (achou.length !== 1) return { ok: false, motivo: achou.length ? 'arquivo-ambiguo' : 'arquivo-inexistente' };
        abs = path.join(dir, achou[0]);
    }
    const linhas = fs.readFileSync(abs, 'utf8').split('\n');
    const ini = Math.max(0, (Number(ref.startLine) || 1) - 1 - 10), fim = Math.min(linhas.length, (Number(ref.endLine) || Number(ref.startLine) || linhas.length) + 10);
    const janela = linhas.slice(ini, fim).map(limpa).join('');
    const pedacos = String(ref.code).split(/\n|\.\.\.|…/).map(limpa).filter(Boolean);
    const total = pedacos.join('');
    if (total.length < 20 || !/[A-Za-z_]{3,}/.test(String(ref.code))) return { ok: false, motivo: 'trecho-trivial' };
    let pos = 0;
    for (const p of pedacos) { const k = janela.indexOf(p, pos); if (k < 0) return { ok: false, motivo: 'nao-encontrado' }; pos = k + p.length; }
    return { ok: true };
}

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[etapa3] ${descreveModelo(MODELO)} · variante ${VAR} · teto ${TETO}`);
    const Q = JSON.parse(fs.readFileSync(FILA, 'utf8'));
    const F = JSON.parse(fs.readFileSync(FUSAO, 'utf8')).prs;
    const vars = {}, diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) { vars[v.caseId] = v; diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n').slice(0, 40000); }
        } catch {}
    }
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, variante: VAR, prs: {} };
    const SO = (arg('only', '') || '').split(',').filter(Boolean);
    const fila = Object.keys(Q).filter((c) => (!SO.length || SO.includes(c)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const reps = Q[cid] || [];
            const decis = {};
            if (reps.length) {
                const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
                const textoDe = Object.fromEntries(F[cid].itens.map((it) => [it.rep, it.texto]));
                h = await prepareRepo(vars[cid], `${cid}-e3-${process.pid}`);
                if (!h) throw new Error('sem repo');
                const cmd = new LocalRepoCommands(h.dir);
                let j = 0;
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (j < reps.length) {
                        const rep = reps[j++];
                        const c = { ...cs[rep], suggestionContent: textoDe[rep] || cs[rep].suggestionContent, existingCode: undefined };
                        const v1 = await retry(() => sessao(model, cmd, c, diffs[cid], h.dir));
                        const d = { v1 };
                        // Protecao 2: so o que a primeira sessao derrubou COM prova passa pela segunda.
                        if (PROTEGE && !v1.keep && v1.leuCitado) d.v2 = await retry(() => sessao(model, cmd, c, diffs[cid], h.dir));
                        decis[rep] = d;
                    }
                }));
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
    const ds = ok.flatMap((p) => Object.values(p.decisoes));
    const passos = {}; for (const d of ds) passos[d.v1.passos] = (passos[d.v1.passos] || 0) + 1;
    console.log(JSON.stringify({ variante: VAR, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, sugestoes: ds.length, dropBruto: ds.filter((d) => !d.v1.keep).length, dropSemLer: ds.filter((d) => !d.v1.keep && !d.v1.leuCitado).length, dropConfirmado: ds.filter((d) => d.v2 && !d.v2.keep && d.v2.leuCitado).length, semVeredito: ds.filter((d) => !d.v1.temVeredito).length, ...(CITA ? { citacao: ds.filter((d) => d.v1.citacao).reduce((a, d) => { const k = d.v1.citacao.ok ? 'ok' : d.v1.citacao.motivo; a[k] = (a[k] || 0) + 1; return a; }, {}) } : {}), passos }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
