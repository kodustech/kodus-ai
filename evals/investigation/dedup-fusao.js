#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821, dedup sem perder golden: depois do dedup (agrupamento gravado com
 * --guard=record e o guarda de producao reaplicado), UMA chamada por PR escreve
 * o texto publicado de cada grupo com mais de um membro, juntando os detalhes
 * de todos os membros. O juiz (Haiku) avalia o texto mesclado contra os goldens;
 * grupos de um membro usam o rotulo ja gravado nas matrizes.
 *
 *   RECALL_MODEL=<id> node dedup-fusao.js --dedup=<arq record> --pool=<orig> --out=arq.json [--prompt=v1]
 */
const fs = require('fs');
const path = require('path');
const { tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { chamadaEstruturada } = require('./eval-structured');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const ARQ = arg('dedup'), POOL = arg('pool'), OUT = arg('out'), PAR = Number(arg('par', '4')), VERSAO = arg('prompt', 'v1');
const GUARDA = arg('guarda', 'producao');
const MODELO = process.env.RECALL_MODEL;
const CORE = new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect']);

// Guarda de producao reaplicado sobre os pares gravados (lexico 0,30 -> embedding 0,70/0,40 -> desempate).
const honra = (p) => GUARDA === 'nenhum' || p.lex >= 0.3 || (p.cos != null && (p.cos >= 0.7 || (p.cos >= 0.4 && p.tb === true)));

const SCHEMA = {
    type: 'object',
    properties: {
        grupos: {
            type: 'array',
            items: {
                type: 'object',
                properties: { grupo: { type: 'number' }, texto: { type: 'string' } },
                required: ['grupo', 'texto'],
                additionalProperties: false,
            },
        },
    },
    required: ['grupos'],
    additionalProperties: false,
};
const SCHEMA_V5 = {
    type: 'object',
    properties: { grupos: { type: 'array', items: { type: 'object', properties: { grupo: { type: 'number' }, separar: { type: 'array', items: { type: 'number' } }, texto: { type: 'string' } }, required: ['grupo', 'separar', 'texto'], additionalProperties: false } } },
    required: ['grupos'],
    additionalProperties: false,
};
const SCHEMA_V4 = {
    type: 'object',
    properties: { grupos: { type: 'array', items: { type: 'object', properties: { grupo: { type: 'number' }, separar: { type: 'array', items: { type: 'number' } } }, required: ['grupo', 'separar'], additionalProperties: false } } },
    required: ['grupos'],
    additionalProperties: false,
};
const fusaoTool = tool({ description: 'Registra o texto de cada grupo. Chame exatamente uma vez.', inputSchema: jsonSchema(SCHEMA), execute: async () => ({ output: 'ok' }) });
const v5Tool = tool({ description: 'Registra separacoes e o texto de cada grupo. Chame exatamente uma vez.', inputSchema: jsonSchema(SCHEMA_V5), execute: async () => ({ output: 'ok' }) });
const separarTool = tool({ description: 'Registra quais descartados ficam como comentario proprio. Chame exatamente uma vez.', inputSchema: jsonSchema(SCHEMA_V4), execute: async () => ({ output: 'ok' }) });

const PROMPTS = {
    v1: (grupos) => `Each group below holds code review findings that a deduplication step judged to be the SAME defect. Only ONE comment per group will be posted on the pull request. Write that comment.

${grupos.map((g, i) => `<Group ${i}>\n${g.map((c) => `- ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}\n  ${String(c.suggestionContent || '').slice(0, 1500)}`).join('\n')}\n</Group ${i}>`).join('\n\n')}

Rules for each comment:
- Keep EVERY concrete detail that any finding in the group gives: the exact code, file and line, the triggering condition, and EACH distinct consequence or failure it causes. Two findings describing the same root cause often name different consequences — keep all of them.
- If the findings in a group actually describe different defects, describe each one.
- Do not add anything the findings do not say. Do not include suggested fixes or test advice.
- Plain prose, as compact as the details allow.

Call the tool once with one entry per group index.`,
    // v5: separa o que e outro defeito (texto original) e reescreve o resto como UM defeito.
    v5: (grupos) => `Each group below holds code review findings that a deduplication step merged as the SAME defect. Only ONE comment per defect will be posted.

${grupos.map((g, i) => `<Group ${i}>\n${g.map((c, j) => `[${j}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}\n  ${String(c.suggestionContent || '').slice(0, 1500)}`).join('\n')}\n</Group ${i}>`).join('\n\n')}

For each group:
1. "separar": list the indices (1 and up) of findings that report a DIFFERENT defect from [0] — different faulty code, a different file, function or call site, or a different root cause. They will be posted as their own comment, unchanged. Findings with the same root cause in the same code stay, even if they describe a different consequence.
2. "texto": write the ONE comment for [0] and the findings that stay. It describes a single defect. Keep every concrete detail any of them gives about THAT defect: the exact code, file and line, each triggering condition, and EACH consequence or failure they name. Leave out anything about other defects or side remarks (they belong to another comment), suggested fixes and test advice. Do not add anything the findings do not say.

Call the tool once with one entry per group index.`,
    // v4: nenhum texto reescrito; o LLM so diz quais descartados sao OUTRO defeito (voltam como comentario proprio).
    v4: (grupos) => `Each group below holds code review findings that a deduplication step merged as the SAME defect. Finding [0] of each group will be posted; the others will be dropped as duplicates. Check that decision.

${grupos.map((g, i) => `<Group ${i}>\n${g.map((c, j) => `[${j}]${j === 0 ? ' (posted)' : ''} ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}\n  ${String(c.suggestionContent || '').slice(0, 1500)}`).join('\n')}\n</Group ${i}>`).join('\n\n')}

For each dropped finding (index 1 and up), decide:
- DUPLICATE: it reports the same defect as [0] — same faulty code and the same failure. A developer who fixes what [0] describes has also fixed this one, and reading [0] tells them everything this one says that matters. Drop it.
- SEPARATE: it reports something [0] does not: a different defect, the same defect in a different file, function or call site that [0] does not mention, or a failure/consequence that [0] does not describe and that a developer reading only [0] would not know about. Keep it as its own comment.

Name each finding's root cause and consequence before deciding. When in doubt, SEPARATE.

Call the tool once with one entry per group index; "separar" lists the indices (1 and up) to keep as their own comment, empty if all are duplicates.`,
    // v3: o LLM so escreve os ACRESCIMOS; o texto da representante fica intacto (montado no codigo).
    v3: (grupos) => `Each group below holds code review findings that a deduplication step judged to be the SAME defect. The first finding [0] of each group is the one that will be posted, unchanged. The other findings are being dropped as duplicates.

${grupos.map((g, i) => `<Group ${i}>\n${g.map((c, j) => `[${j}]${j === 0 ? ' (posted)' : ''} ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}\n  ${String(c.suggestionContent || '').slice(0, 1500)}`).join('\n')}\n</Group ${i}>`).join('\n\n')}

For each group, list what the dropped findings say that [0] does NOT already say: a different consequence or failure, a different triggering condition, a different affected file, line or caller, or a different defect altogether. One short sentence each, keeping the dropped finding's own wording (identifiers, conditions, consequences). No suggested fixes, no test advice, nothing [0] already covers. If they add nothing, return an empty text.

Return the sentences joined with newlines as "texto". Call the tool once with one entry per group index.`,
    v2: (grupos) => `Each group below holds code review findings that a deduplication step judged to be the SAME defect. Only ONE comment per group will be posted on the pull request. Write that comment.

${grupos.map((g, i) => `<Group ${i}>\n${g.map((c, j) => `[${j}] ${c.relevantFile}:${c.relevantLinesStart ?? '?'}-${c.relevantLinesEnd ?? '?'}\n  ${String(c.suggestionContent || '').slice(0, 1500)}`).join('\n')}\n</Group ${i}>`).join('\n\n')}

Format of each comment:
1. One sentence naming the defect: the code, file and line.
2. Then one bullet per finding in the group, in order. Each bullet copies that finding's own key sentence about WHAT fails and WHEN, keeping its original wording (identifiers, conditions, consequences). Shorten only by cutting suggested fixes, test advice and repetition of the first sentence. Never drop a finding's bullet, even if it looks like the others.

Do not add anything the findings do not say.

Call the tool once with one entry per group index.`,
};

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }

(async () => {
    const model = buildModel(MODELO);
    console.log(`[dedup-fusao] ${descreveModelo(MODELO)} · prompt ${VERSAO} · guarda ${GUARDA}`);
    const R = JSON.parse(fs.readFileSync(ARQ, 'utf8')).prs;
    const M = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', `matriz-${POOL}.json`), 'utf8'));
    const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', `matriz-descartados-${POOL}.json`), 'utf8'));
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const chave = loadJudgeKey();
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { prs: {} };
    const fila = L30.filter((c) => !res.prs[c] || res.prs[c].erro);
    let i = 0;
    const um = async (cid) => {
        try {
            const cs = JSON.parse(fs.readFileSync(path.join(__dirname, 'pools', `${POOL}-heavysv`, `${cid}.raw.txt`), 'utf8')).trace.preFilterCandidates;
            const m0 = M[cid] || D[cid];
            const confsDe = (k) => {
                const mm = (cs[k]._src === 'M' ? M : D)[cid];
                return m0.goldens.map((g, gi) => (CORE.has(g.category) && cs[k]._col < mm.conf[gi].length ? mm.conf[gi][cs[k]._col] : 0));
            };
            const p = R[cid];
            // Rodada sem --guard=record: usa os grupos ja decididos (membros).
            const grupos = p.pares ? Object.fromEntries([...new Set([...(p.keptPre || []), ...(p.unmentioned || [])])].map((k) => [k, [k]]))
                : Object.fromEntries(Object.entries(p.membros).map(([k, g]) => [k, g]));
            for (const x of p.pares || []) {
                if (honra(x)) (grupos[x.keptInto] = grupos[x.keptInto] || [x.keptInto]).push(x.idx);
                else grupos[x.idx] = grupos[x.idx] || [x.idx];
            }
            let multi = Object.entries(grupos).filter(([, g]) => g.length > 1);
            let textos = {};
            if (multi.length && VERSAO === 'v5') {
                const r = await retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'fundir', schema: SCHEMA_V5, toolDef: v5Tool, prompt: PROMPTS.v5(multi.map(([, g]) => g.map((k) => cs[k]))) }));
                const vistos = new Set();
                for (const e of r.dados?.grupos || []) {
                    const ent = multi[e.grupo]; if (!ent || !e.texto) continue; vistos.add(e.grupo);
                    for (const j of e.separar || []) {
                        const k = ent[1][j]; if (j < 1 || k == null) continue;
                        grupos[ent[0]] = grupos[ent[0]].filter((x) => x !== k); grupos[k] = [k];
                    }
                    if (grupos[ent[0]].length > 1) textos[ent[0]] = e.texto;
                }
                if (vistos.size < multi.length) throw new Error(`${multi.length - vistos.size} grupos sem decisao`);
                multi = [];
            }
            if (multi.length && VERSAO === 'v4') {
                const r = await retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'separar', schema: SCHEMA_V4, toolDef: separarTool, prompt: PROMPTS.v4(multi.map(([, g]) => g.map((k) => cs[k]))) }));
                const vistos = new Set();
                for (const e of r.dados?.grupos || []) {
                    const ent = multi[e.grupo]; if (!ent) continue; vistos.add(e.grupo);
                    for (const j of e.separar || []) {
                        const k = ent[1][j]; if (j < 1 || k == null) continue;
                        grupos[ent[0]] = grupos[ent[0]].filter((x) => x !== k); grupos[k] = [k];
                    }
                }
                if (vistos.size < multi.length) throw new Error(`${multi.length - vistos.size} grupos sem decisao`);
                multi = [];
            }
            if (multi.length) {
                const r = await retry(() => chamadaEstruturada({ model, modelId: MODELO, nome: 'fusao', schema: SCHEMA, toolDef: fusaoTool, prompt: PROMPTS[VERSAO](multi.map(([, g]) => g.map((k) => cs[k]))) }));
                for (const e of r.dados?.grupos || []) {
                    if (!multi[e.grupo]) continue;
                    const rep = multi[e.grupo][0];
                    if (VERSAO === 'v3') {
                        const extras = String(e.texto || '').split('\n').map((x) => x.replace(/^[-*\s]+/, '').trim()).filter(Boolean);
                        textos[rep] = cs[+rep].suggestionContent + (extras.length ? `\n\nAlso reported:\n${extras.map((x) => `- ${x}`).join('\n')}` : '');
                    } else if (e.texto) textos[rep] = e.texto;
                }
                const falta = multi.filter(([rep]) => !textos[rep]).length;
                if (falta) throw new Error(`${falta} grupos sem texto`);
            }
            const itens = await Promise.all(Object.entries(grupos).map(async ([rep, g]) => {
                if (g.length === 1 || !textos[rep]) return { rep: +rep, membros: g, confs: confsDe(+rep) };
                const confs = await Promise.all(m0.goldens.map(async (gd) => {
                    if (!CORE.has(gd.category)) return 0;
                    const v = await matchCommentDetailed(chave, gd.comment, textos[rep]);
                    return v?.match ? v.confidence ?? 0 : 0;
                }));
                return { rep: +rep, membros: g, texto: textos[rep], confs };
            }));
            const pre = new Set(); for (let k = 0; k < cs.length; k++) confsDe(k).forEach((x, gi) => { if (x > 0) pre.add(gi); });
            res.prs[cid] = { itens, goldensPre: [...pre] };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            fs.writeFileSync(OUT, JSON.stringify(res));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    let pre = 0, pos = 0, perdidos = [], n = 0, gold = 0, fp = 0;
    for (const [cid, p] of Object.entries(res.prs)) {
        if (p.erro) continue;
        n += p.itens.length;
        const venc = new Set();
        const ng = p.itens[0]?.confs.length || 0;
        for (let gi = 0; gi < ng; gi++) {
            let b = 0, q = -1;
            p.itens.forEach((it, j) => { if (it.confs[gi] > b) { b = it.confs[gi]; q = j; } });
            if (q >= 0) { gold++; venc.add(q); }
            else if (p.goldensPre.includes(gi)) perdidos.push(`${cid.slice(0, 40)}#${gi}`);
        }
        fp += p.itens.length - venc.size;
    }
    const total = 111;
    console.log(JSON.stringify({ prs: Object.values(res.prs).filter((p) => !p.erro).length, erros: Object.values(res.prs).filter((p) => p.erro).length, comentarios: n, gold, recall: gold / total, precisao: gold / (gold + fp), perdidos }));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
