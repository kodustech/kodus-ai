#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: classifica por LLM os patches que o verify pela correcao escreveu (no lugar
 * da checagem do tree-sitter): o patch so mexe em comentario/espaco? so mexe no texto de strings?
 * Uma chamada one-shot por patch, no modelo do cenario, com as linhas originais e o
 * codigo novo.
 *
 *   RECALL_MODEL=<id> node classifica-patch.js --verify=<saida do verify-novo> --fila=<arq> --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { chamadaEstruturada } = require('./eval-structured');
const { prepareRepo } = require('./prepare-repo');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const V = JSON.parse(fs.readFileSync(arg('verify'), 'utf8')).prs;
const OUT = arg('out'), PAR = Number(arg('par', '3'));
const MODELO = process.env.RECALL_MODEL;

const SCHEMA = {
    type: 'object',
    properties: {
        onlyCommentsOrWhitespace: { type: 'boolean', description: 'true only if the ONLY differences are in code comments, whitespace or line breaks. Any change to executable code makes it false.' },
        onlyStringText: { type: 'boolean', description: 'true only if the ONLY differences are inside string literals (the text between quotes), whatever the string is used for: log message, error message, user-facing text, translation key. If anything outside the quotes changes (a call, a variable, an operator, a new line of code, an interpolated expression), it is false.' },
    },
    required: ['onlyCommentsOrWhitespace', 'onlyStringText'],
    additionalProperties: false,
};
const classTool = tool({ description: 'Record the classification. Call exactly once.', inputSchema: jsonSchema(SCHEMA), execute: async () => ({ output: 'ok' }) });
const prompt = (file, antes, depois) => `A code change in ${file}. Lines before the change:
<Before>
${antes}
</Before>
Lines after the change:
<After>
${depois}
</After>

Classify the change:
- onlyCommentsOrWhitespace: true only if the ONLY differences are in code comments, whitespace or line breaks. Any change to executable code makes it false.
- onlyStringText: true only if the ONLY differences are inside string literals (the text between quotes), whatever the string is used for: log message, error message, user-facing text, translation key. If anything outside the quotes changes (a call, a variable, an operator, a new line of code, an interpolated expression), it is false.`;

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[classifica-patch] ${descreveModelo(MODELO)}`);
    const vars = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, prs: {} };
    const fila = Object.keys(V).filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const alvos = Object.entries(V[cid].decisoes || {}).filter(([, d]) => d.fixNeeded && d.checagem?.aplica);
            const cls = {};
            if (alvos.length) {
                h = await prepareRepo(vars[cid], `${cid}-cp-${process.pid}`);
                if (!h) throw new Error('sem repo');
                for (const [rep, d] of alvos) {
                    const linhas = fs.readFileSync(path.join(h.dir, d.checagem.arquivo), 'utf8').split('\n');
                    const a = Number(d.fix.startLine), b = Number(d.fix.endLine);
                    const antes = linhas.slice(a - 1, b).join('\n');
                    const r = await retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'classifica', schema: SCHEMA, toolDef: classTool, prompt: prompt(d.checagem.arquivo, antes, d.fix.newCode) }));
                    if (typeof r.dados?.onlyCommentsOrWhitespace !== 'boolean' || typeof r.dados?.onlyStringText !== 'boolean') throw new Error('sem classificacao');
                    cls[rep] = { onlyCommentsOrWhitespace: r.dados.onlyCommentsOrWhitespace, onlyStringText: r.dados.onlyStringText };
                }
            }
            res.prs[cid] = { cls };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const cs = ok.flatMap((p) => Object.values(p.cls));
    console.log(JSON.stringify({ prs: ok.length, erros: Object.keys(res.prs).length - ok.length, patches: cs.length, onlyCommentsOrWhitespace: cs.filter((x) => x.onlyCommentsOrWhitespace).length, onlyStringText: cs.filter((x) => x.onlyStringText).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
