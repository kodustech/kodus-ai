#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: duplicatas de acerto no fim. Sobre a lista que seria publicada (fila do
 * corte + verify B com topo 3 garantido e protecao 1), acha os pares no mesmo
 * arquivo com linhas sobrepostas e pergunta ao LLM do cenario, uma chamada por
 * PR, se cada par e o mesmo bug. Se for, sai o que esta mais baixo na fila.
 * Mede tambem a regra sozinha (todo par sobreposto derruba o de baixo).
 *
 *   RECALL_MODEL=<id> node dup-final.js --fusao=<arq> --fila=<arq> --verify=<arq> --pool=<orig> --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { chamadaEstruturada } = require('./eval-structured');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const F = JSON.parse(fs.readFileSync(arg('fusao'), 'utf8')).prs;
const Q = JSON.parse(fs.readFileSync(arg('fila'), 'utf8'));
const V = JSON.parse(fs.readFileSync(arg('verify'), 'utf8')).prs;
const POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '4'));
const MODELO = process.env.RECALL_MODEL;

const SCHEMA = {
    type: 'object',
    properties: {
        pares: {
            type: 'array',
            items: {
                type: 'object',
                properties: { par: { type: 'number' }, rootCauseA: { type: 'string' }, rootCauseB: { type: 'string' }, sameBug: { type: 'boolean' } },
                required: ['par', 'rootCauseA', 'rootCauseB', 'sameBug'],
                additionalProperties: false,
            },
        },
    },
    required: ['pares'],
    additionalProperties: false,
};
const parTool = tool({ description: 'Record the verdict for every pair. Call exactly once.', inputSchema: jsonSchema(SCHEMA), execute: async () => ({ output: 'ok' }) });

const prompt = (pares) => `Each pair below holds two code review comments that will be posted on the same pull request, on overlapping lines of the same file. Decide for each pair whether posting both would be a REDUNDANT DUPLICATE (the same underlying defect) or whether they are DIFFERENT bugs that both deserve a comment.

First, in one short phrase each, state the single root-cause defect of A and of B. Then compare:
- sameBug = TRUE when both point at the SAME defect, even if the wording, the emphasis or the consequence they describe differ.
- sameBug = FALSE when the defects are genuinely different problems, even if they sit on the same lines or in the same function.

${pares.map((p, i) => `<Pair ${i}>\nA: ${p.a.file}:${p.a.linhas}\n${String(p.a.texto).slice(0, 1800)}\n\nB: ${p.b.file}:${p.b.linhas}\n${String(p.b.texto).slice(0, 1800)}\n</Pair ${i}>`).join('\n\n')}

Call the tool once with an entry for every pair index.`;

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();
const mesmoArquivo = (a, b) => { a = norm(a); b = norm(b); return !!a && !!b && (a === b || a.endsWith('/' + b) || b.endsWith('/' + a)); };
const sobrepoe = (x, y) => {
    const a1 = Number(x.relevantLinesStart), a2 = Number(x.relevantLinesEnd) || a1, b1 = Number(y.relevantLinesStart), b2 = Number(y.relevantLinesEnd) || b1;
    return [a1, a2, b1, b2].every(Number.isFinite) && a1 <= b2 && b1 <= a2;
};

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[dup-final] ${descreveModelo(MODELO)}`);
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, prs: {} };
    const fila = Object.keys(Q).filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        try {
            const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            const texto = Object.fromEntries(F[cid].itens.map((it) => [it.rep, it.texto || cs[it.rep].suggestionContent]));
            // Lista publicada, na ordem da fila: topo 3 + o que o verify B manteve (protecao 1).
            const pubs = (Q[cid] || []).filter((r, p) => {
                if (p < 3) return true;
                const d = V[cid]?.decisoes?.[String(r)]?.v1;
                return !(d && d.keep === false && d.leuCitado);
            });
            const pares = [];
            for (let x = 0; x < pubs.length; x++) for (let y = x + 1; y < pubs.length; y++) {
                const A = cs[pubs[x]], B = cs[pubs[y]];
                if (mesmoArquivo(A.relevantFile, B.relevantFile) && sobrepoe(A, B)) {
                    pares.push({ alto: pubs[x], baixo: pubs[y], a: { file: A.relevantFile, linhas: `${A.relevantLinesStart}-${A.relevantLinesEnd}`, texto: texto[pubs[x]] }, b: { file: B.relevantFile, linhas: `${B.relevantLinesStart}-${B.relevantLinesEnd}`, texto: texto[pubs[y]] } });
                }
            }
            let veredito = [];
            if (pares.length) {
                const r = await retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'pares', schema: SCHEMA, toolDef: parTool, prompt: prompt(pares) }));
                const por = Object.fromEntries((r.dados?.pares || []).map((x) => [Number(x.par), x]));
                if (pares.some((_, k) => typeof por[k]?.sameBug !== 'boolean')) throw new Error('par sem veredito');
                veredito = pares.map((_, k) => ({ sameBug: por[k].sameBug, rootCauseA: String(por[k].rootCauseA || '').slice(0, 200), rootCauseB: String(por[k].rootCauseB || '').slice(0, 200) }));
            }
            res.prs[cid] = { publicados: pubs, pares: pares.map((p, k) => ({ alto: p.alto, baixo: p.baixo, ...(veredito[k] || {}) })) };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const ps = ok.flatMap((p) => p.pares);
    console.log(JSON.stringify({ prs: ok.length, erros: Object.keys(res.prs).length - ok.length, pares: ps.length, mesmoBug: ps.filter((p) => p.sameBug).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
