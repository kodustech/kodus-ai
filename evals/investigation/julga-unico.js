#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: cada sugestao do finder (generalista + lentes) fala de UM problema so?
 * Dois juizes independentes leem o suggestionContent de cada candidato de um
 * pool; consenso: e unica so se os dois disserem que e. Uma chamada por PR e
 * por juiz, com as sugestoes numeradas.
 *
 *   node julga-unico.js --pool=<dir em pools/> --out=arq.json [--juizes=claude-opus-5.5@sdk,gpt-6-astra@sub] [--defeito=1] [--tec=G,M3]
 *
 *   --defeito=1  segunda pergunta: a sugestao aponta um defeito que pede correcao
 *                (false = so confirma que esta certo, descreve o codigo, etc.)
 *   --tec=G,M3   so o generalista (generalist-base) e as lentes M3 (micro-exp-p3-*)
 */
const fs = require('fs');
const path = require('path');
const { tool, jsonSchema } = require('ai');
const { buildModel } = require('./eval-model');
const { chamadaEstruturada } = require('./eval-structured');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '3'));
const JUIZES = arg('juizes', 'claude-opus-5.5@sdk,gpt-6-astra@sub').split(',');
const DEFEITO = arg('defeito', '') === '1';
const TEC = (arg('tec', '') || '').split(',').filter(Boolean);
const tecDe = (pb) => (pb === 'generalist-base' ? 'G' : String(pb || '').startsWith('micro-exp-p3-') ? 'M3' : null);

const SCHEMA = {
    type: 'object',
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                properties: { index: { type: 'number' }, single: { type: 'boolean' }, problems: { type: 'number' }, ...(DEFEITO ? { defect: { type: 'boolean' } } : {}) },
                required: ['index', 'single', 'problems', ...(DEFEITO ? ['defect'] : [])],
                additionalProperties: false,
            },
        },
    },
    required: ['items'],
    additionalProperties: false,
};
const juizTool = tool({ description: 'Record the verdict for every suggestion. Call exactly once.', inputSchema: jsonSchema(SCHEMA), execute: async () => ({ output: 'ok' }) });

const prompt = (cs) => `Below are code review suggestions written about one pull request. For EACH suggestion, decide whether it talks about exactly ONE problem or about more than one.

- single = true: it describes one defect — one root cause and the failure it causes. Explaining the trigger, the consequences, or how to fix that same defect is still one problem. The same root cause showing up at several places is still one problem.
- single = false: it describes two or more distinct defects — different root causes that would be fixed independently (for example "a missing validation and also a wrong argument", "this leaks X and additionally Y is never closed").

"problems" is how many distinct problems the suggestion describes (1 when single is true).
${DEFEITO ? `
"defect": does the suggestion report a defect that requires a code change? true when it states that something is wrong and needs fixing. false when it only confirms that the code is correct, safe or already handled, says no change is needed, or just describes what the code does.
` : ''}
${cs.map((c, i) => `[${i}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}\n${String(c.suggestionContent || '').slice(0, 2500)}`).join('\n\n')}

Answer with one entry for every index from 0 to ${cs.length - 1}.`;

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const dir = path.join(__dirname, 'pools', POOL);
    const modelos = Object.fromEntries(JUIZES.map((j) => [j, buildModel(j)]));
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { pool: POOL, juizes: JUIZES, prs: {} };
    const casos = fs.readdirSync(dir).filter((f) => f.endsWith('.raw.txt')).map((f) => f.replace(/\.raw\.txt$/, ''));
    const fila = casos.filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        try {
            const todos = JSON.parse(fs.readFileSync(path.join(dir, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates || [];
            // k continua sendo o indice no preFilterCandidates, mesmo com --tec.
            const cs = todos.map((c, k) => ({ ...c, _k: k })).filter((c) => !TEC.length || TEC.includes(tecDe(c.producedBy)));
            const votos = {};
            if (cs.length) {
                await Promise.all(JUIZES.map(async (j) => {
                    const r = await retry(async () => {
                        const x = await chamadaEstruturada({ model: modelos[j], modelId: j, nome: 'unico', schema: SCHEMA, toolDef: juizTool, prompt: prompt(cs) });
                        const por = Object.fromEntries((x.dados?.items || []).map((it) => [Number(it.index), it]));
                        if (cs.some((_, k) => typeof por[k]?.single !== 'boolean')) throw new Error(`${j}: veredito incompleto`);
                        return por;
                    });
                    votos[j] = r;
                }));
            }
            res.prs[cid] = {
                itens: cs.map((c, k) => ({
                    k: c._k, producedBy: c.producedBy, arquivo: c.relevantFile, ini: c.relevantLinesStart, fim: c.relevantLinesEnd,
                    texto: String(c.suggestionContent || '').slice(0, 1500),
                    votos: Object.fromEntries(JUIZES.map((j) => [j, { single: votos[j][k].single, problems: votos[j][k].problems, ...(DEFEITO ? { defect: votos[j][k].defect } : {}) }])),
                    unica: JUIZES.every((j) => votos[j][k].single),
                    ...(DEFEITO ? { defeito: JUIZES.every((j) => votos[j][k].defect) } : {}),
                })),
            };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const its = ok.flatMap((p) => p.itens);
    const pct = (xs) => (xs.length ? `${((xs.filter((x) => x.unica).length / xs.length) * 100).toFixed(1)}% (${xs.filter((x) => x.unica).length}/${xs.length})` : '-');
    const gen = its.filter((x) => String(x.producedBy || '').startsWith('generalist'));
    const lentes = its.filter((x) => !String(x.producedBy || '').startsWith('generalist'));
    const porJuiz = Object.fromEntries(JUIZES.map((j) => [j, `${((its.filter((x) => x.votos[j].single).length / Math.max(1, its.length)) * 100).toFixed(1)}%`]));
    const semDefeito = DEFEITO ? its.filter((x) => x.defeito === false).length : undefined;
    console.log(JSON.stringify({ prs: ok.length, erros: Object.keys(res.prs).length - ok.length, sugestoes: its.length, unicaConsenso: pct(its), generalista: pct(gen), lentes: pct(lentes), porJuiz, ...(DEFEITO ? { semDefeito } : {}) }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
