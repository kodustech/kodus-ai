#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821, precisao: a nota de veracidade de PRODUCAO (buildVeracityPrompt do
 * finding-reducer: uma chamada por PR, diff do PR, sem ferramentas, 0-100 de
 * "a afirmacao e verdadeira neste codigo") sobre as sugestoes que passaram pelo
 * dedup de producao (results/dedup-prod2). No modelo do cenario.
 *
 *   RECALL_MODEL=<id> node veracidade-dedup.js --sufixo=deepseek --pool=<orig> --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { chamadaEstruturada } = require('./eval-structured');
const { buildVeracityPrompt, VERACITY_SCHEMA } = require('../../libs/code-review/infrastructure/agents/engine/finding-reducer.ts');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const SUFIXO = arg('sufixo'), POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '4'));
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const MODELO = process.env.RECALL_MODEL;

const veracidadeTool = tool({
    description: 'Registra a veracidade de cada achado. Chame exatamente uma vez.',
    inputSchema: jsonSchema(VERACITY_SCHEMA),
    execute: async () => ({ output: 'ok' }),
});

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[veracidade] ${descreveModelo(MODELO)} · ${SUFIXO}`);
    const DD = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'dedup-prod2', `${SUFIXO}.json`), 'utf8')).prs;
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
            let itens = [];
            if (kept.length) {
                const r = await retry(() => chamadaEstruturada({
                    model, modelId: MODELO, nome: 'veracidade', schema: VERACITY_SCHEMA, toolDef: veracidadeTool,
                    prompt: buildVeracityPrompt(kept.map((k) => cands[k]), diffs[cid]),
                }));
                itens = r.dados?.itens || [];
            }
            const porIdx = Object.fromEntries(itens.map((x) => [Number(x.indice), x]));
            const faltando = kept.filter((_, j) => !Number.isFinite(Number(porIdx[j]?.verdadeiro))).length;
            if (faltando) throw new Error(`${faltando} sugestoes sem veracidade`);
            res.prs[cid] = { itens: kept.map((k, j) => ({ k, veracidade: Number(porIdx[j].verdadeiro), ancora: porIdx[j].ancora })), ms: Date.now() - t0 };
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
    const vs = ok.flatMap((p) => p.itens.map((x) => x.veracidade));
    const hist = {}; for (const v of vs) hist[v] = (hist[v] || 0) + 1;
    console.log(JSON.stringify({ sufixo: SUFIXO, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, itens: vs.length, hist }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
