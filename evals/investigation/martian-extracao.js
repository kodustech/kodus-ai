#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821: pontua o que publicariamos do jeito da Martian
 * (withmartian/code-review-benchmark, offline/code_review_benchmark):
 *   step2   extracao — TODOS os comentarios do PR num texto so ("\n\n---\n\n"),
 *           uma chamada que devolve a lista de problemas;
 *   step2_5 dedup    — agrupa duplicados; o irmao de um casado nao vira FP,
 *           mas continua no denominador;
 *   step3   juiz     — o nosso recall-judge, que ja segue a regra deles;
 *           precisao = goldens casados / itens extraidos.
 * Prompts copiados literalmente do repositorio deles. Nos resultados publicados
 * eles usam UM modelo para extracao, dedup e juiz (results/{modelo}/); aqui e o
 * nosso juiz (JUDGE_MODEL, claude-haiku-4-5), temperatura 0. E medicao, como o
 * juiz: nao entra na regra de um modelo por cenario.
 *
 *   node martian-extracao.js --sufixo=deepseek --pool=<rodada> --fonte=stage2|bruto --out=arq.json
 *
 * stage2 = os grupos do agrupamento (descricao fundida, ou a do representante);
 * bruto  = todos os candidatos G+M3 sem agrupamento nem verify.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateText } = require('ai');
const { createAnthropic } = require('@ai-sdk/anthropic');
const { loadJudgeKey, matchCommentDetailed, JUDGE_MODEL } = require('./recall-judge');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const SUFIXO = arg('sufixo');
const POOL = arg('pool');
const FONTE = arg('fonte', 'stage2');
const OUT = arg('out');
const PAR = Number(arg('par', '4'));
if (!SUFIXO || !POOL || !OUT) throw new Error('uso: --sufixo= --pool= --fonte=stage2|bruto --out=');

const CORE = new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect']);
const tec = (l) =>
    l === 'generalist-base' ? 'G' : l === 'synthesis-rescue' ? 'S' : l.startsWith('micro-exp-p1g-') ? 'M1' : l.startsWith('micro-exp-p3-') ? 'M3' : '?';

// ---- prompts da Martian, literais ----
const EXTRACT_SYSTEM = 'You extract code review issues from comments. Always respond with valid JSON.';
const EXTRACT_PROMPT = (comment) => `You are analyzing an AI code review comment to extract individual issues mentioned.

The comment may discuss multiple distinct problems. Extract each separate issue as a standalone item.

Code Review Comment:
${comment}

Instructions:
- Extract each distinct code issue, bug, or concern mentioned
- Each issue should be a single, specific problem (not a general observation)
- Ignore meta-commentary like "I found 2 issues" - extract the actual issues
- Ignore sign-offs, greetings, or formatting instructions
- If the comment contains no actionable code review issues, return an empty list

Example input:
"Found several problems: 1) The getUserById function doesn't handle null input, which will cause a crash.
2) The cache key uses user.name but should use user.id for uniqueness.
Also, consider adding retry logic for the API call."

Example output:
{"issues": [
  "getUserById function doesn't handle null input, causing potential crash",
  "Cache key uses user.name instead of user.id, breaking uniqueness",
  "Missing retry logic for API call"
]}

Respond with ONLY a JSON object:
{"issues": ["issue 1", "issue 2", ...]}`;
const DEDUP_PROMPT = (candidates) => `You are identifying duplicate code review comments.

Below is a numbered list of issues extracted from an AI tool's code review.
Some tools post the same issue in both a summary comment and an inline comment,
creating near-identical duplicates. Your job is to find those duplicates.

Two candidates are duplicates ONLY IF:
- They describe the same problem AND
- A single code change would fix both (i.e., they would be one bug report)

Two candidates are NOT duplicates if:
- They describe the same TYPE of bug but in different files, functions, or
  classes (e.g., "negative slicing in OptimizedCursorPaginator" vs "negative
  slicing in BasePaginator" are separate issues — fixing one does not fix
  the other)
- They describe related but distinct problems (e.g., "returns wrong type" vs
  "caller crashes because of wrong type" are separate issues)

When in doubt, keep candidates separate — it is better to leave a duplicate
ungrouped than to incorrectly merge two distinct issues.

Candidates:
${candidates}

Return ONLY a JSON object where each group is a list of 0-based indices.
Singletons (no duplicate) must still appear as single-element groups.

Example for 4 candidates where 0 and 2 are duplicates:
{"groups": [[0, 2], [1], [3]]}

Your response:`;

const modelo = createAnthropic({ apiKey: loadJudgeKey() })(JUDGE_MODEL);
async function jsonDe(system, prompt) {
    for (let t = 0; t < 3; t++) {
        try {
            // Na repeticao, pede JSON valido de forma explicita: em temperatura 0
            // a mesma resposta invalida (aspas sem escape) volta igual.
            const pedido = t === 0 ? prompt : `${prompt}\n\nYour previous answer was not valid JSON. Escape every double quote inside strings and return ONLY the JSON object.`;
            const r = await generateText({ model: modelo, ...(system ? { system } : {}), prompt: pedido, temperature: 0 });
            let c = r.text.trim();
            if (c.startsWith('```')) { c = c.split('```')[1]; if (c.startsWith('json')) c = c.slice(4); c = c.trim(); }
            return JSON.parse(c);
        } catch (e) {
            if (t === 2) return { erro: String(e?.message || e).slice(0, 200) };
            await new Promise((ok) => setTimeout(ok, 2000 * 2 ** t));
        }
    }
}

// --comentarios=<arquivo>: {caseId: [texto publicado, ...]} montado fora (ex.:
// cortes do atribuidor). O pool so serve para a lista de PRs.
const ARQ_COMENT = arg('comentarios');
const COMENT = ARQ_COMENT ? JSON.parse(fs.readFileSync(ARQ_COMENT, 'utf8')) : null;
function comentarios(cid, raw, st2) {
    if (COMENT) return (COMENT[cid] || []).filter(Boolean);
    const t = raw.trace;
    const itens = [];
    (t.preFilterCandidates || []).forEach((c) => { if (['G', 'M3'].includes(tec(c.producedBy || ''))) itens.push(c); });
    (t.verification?.decisions || []).filter((d) => d.action === 'drop' && d.droppedFinding)
        .map((d) => ({ ...d.droppedFinding, relevantFile: d.relevantFile }))
        .forEach((c) => { if (['G', 'M3'].includes(tec(c.producedBy || ''))) itens.push(c); });
    if (FONTE === 'bruto') return itens.map((c) => c.suggestionContent).filter(Boolean);
    // light = so o G, sem verify (mantidos + derrubados pelo verificador).
    if (FONTE === 'light') return itens.filter((c) => tec(c.producedBy || '') === 'G').map((c) => c.suggestionContent).filter(Boolean);
    // heavy = o corte G+M3 da pagina de recall: o que o verificador manteve.
    if (FONTE === 'heavy') return (t.preFilterCandidates || []).filter((c) => ['G', 'M3'].includes(tec(c.producedBy || ''))).map((c) => c.suggestionContent).filter(Boolean);
    const porIndice = new Map((st2.decisoes?.keep || []).map((k) => [Number(k?.index), k]));
    return (st2.kept || []).map((k) => {
        const e = porIndice.get(k);
        const fundido = e && Array.isArray(e.mergedFrom) && e.mergedFrom.length && e.mergedDescription;
        return fundido ? e.mergedDescription : itens[k]?.suggestionContent;
    }).filter(Boolean);
}

(async () => {
    const dir = path.join(__dirname, 'pools', POOL);
    // --st2=<arquivo>: outra versao do agrupamento (ex.: o prompt de um problema so).
    const arqSt2 = arg('st2') || path.join(__dirname, 'results', 'reducer', `${SUFIXO}-heavy-pre-semdrop-desc.json`);
    const ST2 = fs.existsSync(arqSt2) ? JSON.parse(fs.readFileSync(arqSt2, 'utf8')).prs : {};
    const v2 = JSON.parse(fs.readFileSync(path.join(__dirname, '../benchmark-sets/v002/goldens.json'), 'utf8'));
    const goldensDe = Object.fromEntries(v2.prs.map((p) => [p.caseId, (p.comments || []).filter((g) => CORE.has(g.category))]));
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const chave = loadJudgeKey();
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { prs: {} };
    const fila = L30.filter((c) => (FONTE !== 'stage2' || (ST2[c] && !ST2[c].erro)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, `${cid}.raw.txt`), 'utf8'));
            const corpos = comentarios(cid, raw, ST2[cid] || {});
            const texto = corpos.join('\n\n---\n\n');
            const ex = texto.trim().length >= 20 ? await jsonDe(EXTRACT_SYSTEM, EXTRACT_PROMPT(texto)) : { issues: [] };
            if (ex.erro || !Array.isArray(ex.issues)) throw new Error(`extracao: ${ex.erro || 'sem issues'}`);
            const issues = ex.issues.filter((x) => typeof x === 'string' && x.trim());
            let grupos = null;
            if (issues.length >= 2) {
                const d = await jsonDe(null, DEDUP_PROMPT(issues.map((x, k) => `${k}. ${x}`).join('\n')));
                grupos = Array.isArray(d?.groups) ? d.groups : null;
            }
            const gs = goldensDe[cid] || [];
            // Juiz: golden x item, na ordem deles; vale o primeiro maior que o melhor ate ali.
            const conf = await Promise.all(gs.map((g) => Promise.all(issues.map(async (x) => {
                const v = await matchCommentDetailed(chave, g.comment, x);
                return { match: !!v?.match, confidence: v?.confidence ?? 0 };
            }))));
            const irmaos = new Map();
            for (const grp of grupos || []) for (const a of grp) irmaos.set(a, grp.filter((b) => b !== a));
            const casado = new Set();
            let tp = 0;
            gs.forEach((g, gi) => {
                let melhor = 0, achou = false;
                issues.forEach((_, k) => {
                    const v = conf[gi][k];
                    if (v.match && v.confidence > melhor) {
                        melhor = v.confidence; achou = true; casado.add(k);
                        for (const s of irmaos.get(k) || []) casado.add(s);
                    }
                });
                if (achou) tp++;
            });
            res.prs[cid] = { comentarios: corpos.length, issues, grupos, tp, golden: gs.length, fp: issues.length - casado.size };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const soma = (k) => ok.reduce((a, p) => a + (typeof p[k] === 'number' ? p[k] : p[k].length), 0);
    const total = L30.reduce((a, c) => a + (goldensDe[c] || []).length, 0);
    const tp = soma('tp'), itens = soma('issues'), fp = soma('fp'), coment = soma('comentarios');
    res.resumo = { sufixo: SUFIXO, fonte: FONTE, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, comentarios: coment, itensExtraidos: itens, tp, fp, recall: tp / total, precisaoMartian: itens ? tp / itens : 0, total };
    fs.writeFileSync(OUT, JSON.stringify(res));
    console.log(JSON.stringify(res.resumo));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
