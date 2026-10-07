#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: de onde vem o existingCode — LLM ou leitura deterministica?
 *
 * LLM: uma chamada one-shot por PR, no modelo do cenario, com o diff e as
 * sugestoes da saida enxuta; devolve, por sugestao, o trecho copiado do diff
 * (ou vazio, que conta como descarte). Deterministico: o arquivo do head,
 * exatamente de relevantLinesStart a relevantLinesEnd, sem folga.
 * Compara os dois e confere se o trecho do LLM existe no arquivo.
 *
 *   RECALL_MODEL=<id> node existingcode-teste.js --pool=<orig> --n=10 --out=arq.json
 */
const fs = require('fs');
const path = require('path');
const { tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { chamadaEstruturada } = require('./eval-structured');
const { prepareRepo } = require('./prepare-repo');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const POOL = arg('pool'), OUT = arg('out'), N = Number(arg('n', '10')), PAR = Number(arg('par', '3'));
const MODELO = process.env.RECALL_MODEL;
const CORE = new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect']);

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

const limpa = (t) => String(t || '').replace(/^\s*\d+\s*[:|]\s?/, '').replace(/^[+-](?![+-])/, '').replace(/\s+/g, '');
const normBloco = (t) => String(t || '').split('\n').map(limpa).join('');

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[existingCode] ${descreveModelo(MODELO)} · ${N} PRs`);
    const vars = {}, diffs = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            let arr = v?.changedFilesFull; if (typeof arr === 'string') arr = JSON.parse(arr);
            if (v?.caseId) { vars[v.caseId] = v; diffs[v.caseId] = (arr || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n').slice(0, 60000); }
        } catch {}
    }
    const M = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', `matriz-${POOL}.json`), 'utf8'));
    const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', `matriz-descartados-${POOL}.json`), 'utf8'));
    const L = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8')).slice(0, N);
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { modelo: MODELO, prs: {} };
    const fila = L.filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        let h;
        try {
            const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            const enxuta = cs.map((c) => ({ label: c.label, relevantFile: c.relevantFile, relevantLinesStart: c.relevantLinesStart, relevantLinesEnd: c.relevantLinesEnd, suggestionContent: c.suggestionContent }));
            const r = await retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'existingCode', schema: SCHEMA, toolDef: ecTool, prompt: prompt(enxuta, diffs[cid]) }));
            const por = Object.fromEntries((r.dados?.itens || []).map((x) => [Number(x.indice), x.existingCode]));
            if (enxuta.some((_, j) => typeof por[j] !== 'string')) throw new Error('sugestao sem resposta');
            h = await prepareRepo(vars[cid], `${cid}-ec-${process.pid}`);
            if (!h) throw new Error('sem repo');
            const m0 = M[cid] || D[cid];
            res.prs[cid] = {
                itens: enxuta.map((c, j) => {
                    const abs = path.join(h.dir, String(c.relevantFile || '').replace(/^\.?\/+/, ''));
                    const arquivo = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
                    const a = Number(c.relevantLinesStart), b = Number(c.relevantLinesEnd) || a;
                    const det = arquivo && Number.isFinite(a) && a > 0 ? arquivo.split('\n').slice(a - 1, Math.max(a, b)).join('\n') : '';
                    const llm = por[j] || '';
                    const nl = normBloco(llm), nd = normBloco(det), na = arquivo ? normBloco(arquivo) : '';
                    let rel;
                    if (!nl) rel = 'llm-vazio';
                    else if (!nd) rel = 'det-vazio';
                    else if (nl === nd) rel = 'igual';
                    else if (nd.includes(nl)) rel = 'llm-dentro-do-det';
                    else if (nl.includes(nd)) rel = 'det-dentro-do-llm';
                    else {
                        const ll = llm.split('\n').map(limpa).filter(Boolean);
                        rel = ll.some((x) => x.length > 8 && nd.includes(x)) ? 'sobreposto' : 'diferente';
                    }
                    const mm = (cs[j]._src === 'M' ? M : D)[cid];
                    const golden = m0.goldens.some((g, gi) => CORE.has(g.category) && cs[j]._col < mm.conf[gi].length && mm.conf[gi][cs[j]._col] > 0);
                    return { j, rel, llmExisteNoArquivo: !!nl && na.includes(nl), golden, linhas: `${a}-${b}`, file: c.relevantFile, llm: llm.slice(0, 400), det: det.slice(0, 400) };
                }),
            };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const its = Object.values(res.prs).filter((p) => !p.erro).flatMap((p) => p.itens);
    const rel = {}; for (const x of its) rel[x.rel] = (rel[x.rel] || 0) + 1;
    console.log(JSON.stringify({ prs: Object.values(res.prs).filter((p) => !p.erro).length, erros: Object.values(res.prs).filter((p) => p.erro).length, sugestoes: its.length, rel,
        llmInventado: its.filter((x) => x.rel !== 'llm-vazio' && !x.llmExisteNoArquivo).length, vaziosQueEramGolden: its.filter((x) => x.rel === 'llm-vazio' && x.golden).length }));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
