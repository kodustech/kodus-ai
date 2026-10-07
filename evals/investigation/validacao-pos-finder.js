#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: os dois filtros baratos do comentario do Gabriel, sobre a saida do finder.
 *
 * Teste 1 (nao-achados): deterministico — o arquivo citado existe no head e as
 * linhas cabem nele; LLM — o comentario afirma um defeito.
 * Teste 2 (nits estreitos): LLM — a sugestao e um dos tres tipos: texto que nao
 * passa por i18n, reescrita de mensagem/log/texto de ajuda, codigo nao usado.
 * Uma chamada one-shot por PR, no modelo do cenario, com o diff, respondendo as
 * duas perguntas para cada sugestao.
 *
 *   RECALL_MODEL=<id> node validacao-pos-finder.js --pool=<orig> --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { chamadaEstruturada } = require('./eval-structured');
const { prepareRepo } = require('./prepare-repo');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '3'));
const MODELO = process.env.RECALL_MODEL;

const TIPOS = ['untranslated_string', 'message_rewording', 'unused_code', 'none'];
const SCHEMA = {
    type: 'object',
    properties: {
        itens: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    indice: { type: 'number' },
                    assertsDefect: { type: 'boolean' },
                    narrowNit: { type: 'string', enum: TIPOS },
                },
                required: ['indice', 'assertsDefect', 'narrowNit'],
                additionalProperties: false,
            },
        },
    },
    required: ['itens'],
    additionalProperties: false,
};
const valTool = tool({ description: 'Record the answer for every finding. Call exactly once.', inputSchema: jsonSchema(SCHEMA), execute: async () => ({ output: 'ok' }) });

const prompt = (itens, diff) => `Below are a pull request diff and the findings a review produced on it. Answer two questions for each finding.

<Diff>
${diff}
</Diff>

<Findings>
${itens.map((c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}\n    ${String(c.suggestionContent || '').slice(0, 900)}`).join('\n\n')}
</Findings>

1. assertsDefect — does the finding claim that something in the code is wrong? true when it states a problem: something that fails, behaves incorrectly, is missing, is inconsistent, or should change. false when it only describes, confirms or approves the code ("X is correct", "this is handled", "passed the check", "no issue found"), or it is not about this code at all.

2. narrowNit — is the finding ONLY one of these three, and nothing more?
   - untranslated_string: a user-facing string is hard-coded instead of going through the project's translation / i18n mechanism.
   - message_rewording: it only asks to reword or improve a log message, error message, comment or help text, while the behavior stays correct.
   - unused_code: it only points out code that is never used (an unused variable, import, parameter, function or branch), with no wrong behavior.
   - none: anything else. If the finding also names a wrong behavior (for example a log that leaks secret data, a wrong error code, a message shown in the wrong language to the user because of a bug), it is none.

Call the tool once with an entry for every finding index.`;

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '');
function arquivoELinhas(dir, todos, c) {
    const rel = norm(c.relevantFile);
    if (!rel) return { ok: false, motivo: 'sem-arquivo' };
    let abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) {
        const achou = todos.filter((f) => f === rel || f.endsWith('/' + rel));
        if (achou.length !== 1) return { ok: false, motivo: achou.length ? 'arquivo-ambiguo' : 'arquivo-inexistente' };
        abs = path.join(dir, achou[0]);
    }
    const n = fs.readFileSync(abs, 'utf8').split('\n').length;
    const a = Number(c.relevantLinesStart), b = Number(c.relevantLinesEnd) || a;
    if (!Number.isFinite(a) || a < 1) return { ok: false, motivo: 'linha-invalida' };
    if (a > n || b > n + 1) return { ok: false, motivo: 'linha-fora-do-arquivo' };
    return { ok: true };
}

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[validacao] ${descreveModelo(MODELO)}`);
    const vars = {}, diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) { vars[v.caseId] = v; diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n'); }
        } catch {}
    }
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, prs: {} };
    const fila = L30.filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            let por = {};
            if (cs.length) {
                const r = await retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'validar', schema: SCHEMA, toolDef: valTool, prompt: prompt(cs, diffs[cid]) }));
                por = Object.fromEntries((r.dados?.itens || []).map((x) => [Number(x.indice), x]));
                const falta = cs.filter((_, j) => typeof por[j]?.assertsDefect !== 'boolean' || !TIPOS.includes(por[j]?.narrowNit)).length;
                if (falta) throw new Error(`${falta} sugestoes sem resposta`);
            }
            h = await prepareRepo(vars[cid], `${cid}-vl-${process.pid}`);
            if (!h) throw new Error('sem repo');
            let todos = [];
            try { todos = execFileSync('git', ['-C', h.dir, 'ls-files'], { maxBuffer: 64 * 1024 * 1024 }).toString().split('\n'); } catch {}
            res.prs[cid] = { itens: cs.map((c, j) => ({ j, arquivo: arquivoELinhas(h.dir, todos, c), assertsDefect: por[j].assertsDefect, narrowNit: por[j].narrowNit })) };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const its = ok.flatMap((p) => p.itens);
    const nit = {}; for (const x of its) nit[x.narrowNit] = (nit[x.narrowNit] || 0) + 1;
    console.log(JSON.stringify({ prs: ok.length, erros: Object.keys(res.prs).length - ok.length, sugestoes: its.length, arquivoInvalido: its.filter((x) => !x.arquivo.ok).length, naoAfirmaDefeito: its.filter((x) => !x.assertsDefect).length, nit }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
