#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821, precisao: o atribuidor SO de nota, sem agrupamento. A entrada ja passou
 * pelo dedup de producao (results/dedup-prod2), entao cada sugestao mantida e um
 * defeito. Mesma pergunta dos dez devs donos do codigo, nota 0-100. Grava a nota
 * de cada sugestao com tam/nag do grupo do dedup, para combinar offline.
 *
 *   RECALL_MODEL=<id> node seletor-nota.js --sufixo=deepseek --pool=<orig> --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { chamadaEstruturada } = require('./eval-structured');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const SUFIXO = arg('sufixo'), POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '4'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const MODELO = process.env.RECALL_MODEL;

const SCHEMA = {
    type: 'object',
    properties: {
        notas: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    indice: { type: 'number' },
                    nota: { type: 'number', description: '0-100: quantos dos dez mudariam o codigo, vezes dez.' },
                    porque: { type: 'string', description: 'Uma frase, citando file:line.' },
                },
                required: ['indice', 'nota', 'porque'],
                additionalProperties: false,
            },
        },
    },
    required: ['notas'],
    additionalProperties: false,
};
const pontuarTool = tool({
    description: 'Registra a nota de cada candidato. Chame exatamente uma vez.',
    inputSchema: jsonSchema(SCHEMA),
    execute: async () => ({ output: 'ok' }),
});

const prompt = (cands, diff) => `A review of this pull request produced the findings below. Your job is to say how much each one is worth posting.

<Diff>
${String(diff || '').slice(0, 40000)}
</Diff>

<Candidates>
${cands
    .map((c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}
    ${c.oneSentenceSummary || ''}
    ${String(c.suggestionContent || '').slice(0, 500)}${c.reason ? `\n    walk: ${String(c.reason).slice(0, 400)}` : ''}`)
    .join('\n\n')}
</Candidates>

Give each candidate 0-100: how much is it worth posting this, on this pull request,
to the developer who wrote it.

Imagine ten experienced developers who own this codebase and know it well.
They each read this pull request and this comment. How many of the ten would
CHANGE THE CODE because of it, before merging?

Answer with that count times ten: 0, 10, 20 ... 100.

  100  all ten would change the code — the defect is plain and it matters
  70   seven would; three would argue it is fine as is
  40   four would; the rest would merge and maybe open a follow-up
  10   one might; nine would read past it
  0    none would — they know why this is fine, or the claim is wrong

Answer for the developers who OWN this code, not for a careful outsider. They
know the conventions, they know what is intentional, and they know what the
next commit already handles.

Judge the defect, not the prose. Do not reward a confident tone, and do not
punish a terse one. A real defect described badly still scores high.

Be honest with the low end. This pull request does not owe you findings: if
most of these candidates are noise, most of the scores should be below 40.

Call pontuar exactly once, with a score for every candidate index.`;

function comEsforco(model, modelId) {
    const effort = process.env.RECALL_REASONING_EFFORT;
    if (!effort) return model;
    const { buildReasoningProviderOptions } = require('../../libs/llm/reasoning-options.ts');
    const provider = /^gpt|^o\d/i.test(modelId) ? 'openai' : 'openai_compatible';
    const inj = buildReasoningProviderOptions(provider, effort, modelId);
    if (!inj || !Object.keys(inj).length) return model;
    const merge = (o) => ({ ...o, providerOptions: { ...(o?.providerOptions || {}), ...inj } });
    return new Proxy(model, {
        get(t, p, r) {
            if (p === 'doGenerate' || p === 'doStream') return async (o) => t[p](merge(o));
            return Reflect.get(t, p, r);
        },
    });
}

(async () => {
    // A rota de assinatura ja aplica RECALL_REASONING_EFFORT; o wrapper sobrescreveria store:false.
    const model = /@sub$/.test(MODELO) ? buildModel(MODELO) : comEsforco(buildModel(MODELO), String(MODELO).replace(/@.*$/, ''));
    console.log(`[seletor-nota] ${descreveModelo(MODELO)} · ${SUFIXO} · effort=${process.env.RECALL_REASONING_EFFORT || 'default'}`);
    const DD = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', arg('dedup', 'dedup-prod2'), `${SUFIXO}.json`), 'utf8')).prs;
    const diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n');
        } catch {}
    }
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, prs: {} };
    const fila = L30.filter((c) => (!SO.length || SO.includes(c)) && DD[c] && !DD[c].erro && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        const t0 = Date.now();
        try {
            const cands = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            const kept = DD[cid].kept || [];
            const membros = DD[cid].membros || {};
            const itens = kept.map((k) => cands[k]);
            let notas = [];
            if (itens.length) {
                const r = await retry(() => chamadaEstruturada({
                    model, modelId: MODELO, nome: 'pontuar', schema: SCHEMA, toolDef: pontuarTool, prompt: prompt(itens, diffs[cid]),
                }));
                notas = r.dados?.notas || [];
            }
            const porIdx = Object.fromEntries(notas.map((n) => [Number(n.indice), n]));
            const faltando = kept.filter((_, j) => !porIdx[j]).length;
            if (faltando) throw new Error(`${faltando} candidatos sem nota`);
            res.prs[cid] = {
                itens: kept.map((k, j) => {
                    const mem = (membros[k] || [k]).map((x) => cands[x]?.producedBy || '?');
                    return {
                        k, nota: Number(porIdx[j].nota), porque: porIdx[j].porque,
                        producedBy: cands[k]?.producedBy, membros: mem.length, agentes: new Set(mem).size,
                        texto: cands[k]?.suggestionContent || '',
                    };
                }),
                ms: Date.now() - t0,
            };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${kept.length} itens`);
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${res.prs[cid].erro}`);
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const ns = ok.flatMap((p) => p.itens.map((x) => x.nota));
    const hist = {}; for (const n of ns) hist[n] = (hist[n] || 0) + 1;
    console.log(JSON.stringify({ sufixo: SUFIXO, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, itens: ns.length, hist }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }
