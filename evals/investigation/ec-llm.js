#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: etapa existingCode pelo LLM, antes do dedup. Uma chamada one-shot por
 * PR, no modelo do cenario, com o diff e as sugestoes da saida enxuta; devolve,
 * por sugestao, o trecho copiado do diff. Vazio = a sugestao e descartada.
 *
 *   RECALL_MODEL=<id> node ec-llm.js --pool=<orig> --out=arq.json   ->  {prs: {caseId: {codigo: {indice: trecho}}}}
 */
const fs = require('fs');
const path = require('path');
const { tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { chamadaEstruturada } = require('./eval-structured');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const POOL = arg('pool'), OUT = arg('out'), N = Number(arg('n', '30')), PAR = Number(arg('par', '4'));
const MODELO = process.env.RECALL_MODEL;

const SCHEMA = {
    type: 'object',
    properties: {
        itens: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    indice: { type: 'number' },
                    existingCode: { type: 'string', description: 'The exact lines from the diff, copied without line numbers or +/- markers. Empty string if the diff does not contain the code this finding is about.' },
                },
                required: ['indice', 'existingCode'],
                additionalProperties: false,
            },
        },
    },
    required: ['itens'],
    additionalProperties: false,
};
const ecTool = tool({ description: 'Record the existing code of every finding. Call exactly once.', inputSchema: jsonSchema(SCHEMA), execute: async () => ({ output: 'ok' }) });

const prompt = (itens, diff) => `Below are a pull request diff and the findings a review produced on it. For each finding, copy from the diff the exact code the finding is about.

<Diff>
${diff}
</Diff>

<Findings>
${itens.map((c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}\n    ${String(c.suggestionContent || '').slice(0, 900)}`).join('\n\n')}
</Findings>

Rules:
- Copy the code ONLY from the diff above, character for character: the lines that contain the problem the finding describes. Usually the cited lines; adjust if the cited range is off.
- Do not include line numbers or the diff's +/- markers. Do not rewrite, shorten with "...", or add anything.
- If the diff does not contain the code this finding is about, return an empty string for it.

Call the tool once with an entry for every finding index.`;

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[ec-llm] ${descreveModelo(MODELO)}`);
    const diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n');
        } catch {}
    }
    const L = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8')).slice(0, N);
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, prs: {} };
    const fila = L.filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        try {
            const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            const enxuta = cs.map((c) => ({ relevantFile: c.relevantFile, relevantLinesStart: c.relevantLinesStart, relevantLinesEnd: c.relevantLinesEnd, suggestionContent: c.suggestionContent }));
            let codigo = {};
            if (enxuta.length) {
                const r = await retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'existingCode', schema: SCHEMA, toolDef: ecTool, prompt: prompt(enxuta, diffs[cid]) }));
                codigo = Object.fromEntries((r.dados?.itens || []).map((x) => [Number(x.indice), String(x.existingCode || '')]));
                const falta = enxuta.filter((_, j) => typeof codigo[j] !== 'string').length;
                if (falta) throw new Error(`${falta} sugestoes sem resposta`);
            }
            res.prs[cid] = { codigo };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const tudo = ok.flatMap((p) => Object.values(p.codigo));
    console.log(JSON.stringify({ prs: ok.length, erros: Object.keys(res.prs).length - ok.length, sugestoes: tudo.length, semCodigo: tudo.filter((x) => !x.trim()).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
