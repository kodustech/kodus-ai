#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * #1821, precisao: a etapa de verify DEPOIS do agrupamento (stage 2), sobre os
 * grupos que o reducer sem DROP deixou. Nao gera candidato novo: mede recall e
 * precisao com as matrizes do juiz, julgando so as descricoes fundidas.
 *
 *   RECALL_MODEL=<modelo do pool> node verify-etapa.js --sufixo=deepseek \
 *     --pool=<rodada> --unidade=pr|sugestao --teto=3|5 --modo=keep|score --grafo=0|1 --out=arq.json
 *
 * unidade=sugestao: uma sessao por grupo, com teto de passos (o ultimo passo e o
 *   veredito). Evidence gate: grupo vindo SO do G, em arquivo que o G nao abriu,
 *   roda de novo com teto maior (3 -> 5, 5 -> 8).
 * unidade=pr: uma sessao para todos os grupos do PR, sem teto. O gate roda uma
 *   segunda sessao, tambem sem teto, so com os grupos elegiveis.
 * modo=keep: keep true/false, refutar para derrubar (prompt de producao).
 * modo=score: score de veracidade 0-100; o corte por limiar e feito no fim.
 * grafo=1: o <CallGraph> inteiro do PR vai logo depois das instrucoes, antes das
 *   sugestoes, para o prefixo virar cache.
 * Tudo no modelo do pool (BYOK unico).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { generateText, tool, jsonSchema } = require('ai');
const { buildModel, descreveModelo } = require('./eval-model');
const { prepareRepo } = require('./prepare-repo');
const { LocalRepoCommands } = require('./local-repo-commands');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');
const { buildVerifierPrompt, buildVeracityScorePrompt } = require('../../libs/code-review/infrastructure/agents/prompts/verifier-prompt.ts');
const { bundleFor } = require('../../libs/code-review/infrastructure/agents/core/verifier.agent.ts');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const SUFIXO = arg('sufixo');
const POOL = arg('pool');
const UNIDADE = arg('unidade', 'sugestao');
const TETO = Number(arg('teto', '3'));
const MODO = arg('modo', 'keep');
const GRAFO = arg('grafo', '0') === '1';
const PAR = Number(arg('par', '3'));
const OUT = arg('out');
const SO = (arg('only', '') || '').split(',').filter(Boolean);
const MODELO = process.env.RECALL_MODEL;
if (!SUFIXO || !POOL || !OUT || !MODELO) throw new Error('uso: RECALL_MODEL=... --sufixo= --pool= --unidade= --teto= --modo= --grafo= --out=');

const TETO_GATE = { 3: 5, 5: 8 };
const SEM_TETO = 40; // so uma rede de seguranca: a sessao por PR roda ate decidir.
const CORE = new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect']);
const tec = (l) =>
    l === 'generalist-base' ? 'G' : l === 'synthesis-rescue' ? 'S' : l.startsWith('micro-exp-p1g-') ? 'M1' : l.startsWith('micro-exp-p3-') ? 'M3' : '?';
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();
const ehMuse = /muse/i.test(MODELO);

function readTools(cmd) {
    return {
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({
                type: 'object',
                properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } },
                required: ['pattern'],
                additionalProperties: false,
            }),
            execute: async ({ pattern, path: p, glob }) => {
                try { return String(await cmd.grep(pattern, p, glob)).slice(0, 6000); }
                catch (e) { return `grep failed: ${String(e.message || e).slice(0, 120)}`; }
            },
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({
                type: 'object',
                properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } },
                required: ['path'],
                additionalProperties: false,
            }),
            execute: async ({ path: p, startLine, endLine }) => {
                try { return String(await cmd.read(p, startLine, endLine)).slice(0, 12000); }
                catch (e) { return `readFile failed: ${String(e.message || e).slice(0, 120)}`; }
            },
        }),
    };
}

// ---------- prompts ----------
const KEEP_ITEM = {
    type: 'object',
    properties: {
        keep: { type: 'boolean' },
        rationale: { type: 'string' },
    },
    required: ['keep', 'rationale'],
};
const SCORE_ITEM = {
    type: 'object',
    properties: {
        score: { type: 'number', description: '0-100: how likely the claim is TRUE of this code, after investigating.' },
        rationale: { type: 'string' },
    },
    required: ['score', 'rationale'],
};
const system = MODO === 'score' ? buildVeracityScorePrompt('').system : buildVerifierPrompt('', 0).system;
const sistemaPorPr = (base) =>
    base
        .replace('Your task is to verify ONE candidate finding', 'Your task is to verify EACH candidate finding listed below, one verdict per candidate')
        .replace('You are verifying ONE claim about a pull request.', 'You are verifying EACH claim listed below about a pull request, one score per claim.')
        .replace('Answer ONE question:', 'For each claim, answer ONE question:')
        .replace('- You may use only a few tool calls. Be surgical.\n', '');
const cabecalho = (grafo) => (GRAFO && grafo ? `<CallGraph>\n${grafo}\n</CallGraph>\n\n` : '');
const instrucaoPassos = (teto) =>
    teto >= SEM_TETO
        ? 'Investigate as much as you need, then submit.'
        : `You have ${teto} steps. The LAST one is your answer — submitting is itself a step — so you have ${teto - 1} to investigate with.`;

function promptSugestao(g, grafo, teto) {
    const b = bundleFor({ relevantFile: g.file, relevantLinesStart: g.start, relevantLinesEnd: g.end, suggestionContent: g.text });
    const pedido = MODO === 'score'
        ? 'Submit your score with submitVerdict: {"score": 0-100, "rationale": "what you read, citing file:line"}.'
        : 'Submit your verdict with submitVerdict: {"keep": true|false, "rationale": "why the evidence supports keep/drop"}. keep=true unless you can REFUTE it.';
    return `${cabecalho(grafo)}${b}\n\n${instrucaoPassos(teto)}\n\n${pedido}`;
}

function promptPr(grupos, grafo) {
    const lista = grupos.map((g, i) => `[${i}]\n${bundleFor({ relevantFile: g.file, relevantLinesStart: g.start, relevantLinesEnd: g.end, suggestionContent: g.text })}`).join('\n\n');
    const pedido = MODO === 'score'
        ? 'When done, call submitVerdicts with one entry per candidate index: {"index": i, "score": 0-100, "rationale": "..."}.'
        : 'When done, call submitVerdicts with one entry per candidate index: {"index": i, "keep": true|false, "rationale": "..."}. keep=true unless you can REFUTE it.';
    return `${cabecalho(grafo)}CANDIDATES:\n\n${lista}\n\n${instrucaoPassos(SEM_TETO)}\n\n${pedido}`;
}

// ---------- uma sessao ----------
async function sessao(model, cmd, sys, prompt, teto, submitSchema, nomeSubmit, n) {
    let enviado = null;
    const tools = {
        ...readTools(cmd),
        [nomeSubmit]: tool({
            description: nomeSubmit === 'submitVerdicts' ? 'Submit one verdict per candidate. The only way to answer.' : 'Submit your verdict. The only way to answer.',
            inputSchema: jsonSchema(submitSchema),
            execute: async (x) => { enviado = x; return 'recorded'; },
        }),
    };
    const nota = nomeSubmit === 'submitVerdicts'
        ? `You are at the final step. Call submitVerdicts now with an entry for EVERY candidate index 0-${n - 1}. Do not investigate further.`
        : 'You are at the final step. Call submitVerdict now with the evidence you have. Do not investigate further.';
    const t0 = Date.now();
    const r = await generateText({
        model,
        system: sys,
        prompt,
        tools,
        stopWhen: (x) => !!enviado || (x.steps?.length ?? 0) >= teto,
        prepareStep: ({ stepNumber, messages }) =>
            stepNumber >= teto - 1
                ? {
                      activeTools: [nomeSubmit],
                      ...(ehMuse ? {} : { toolChoice: { type: 'tool', toolName: nomeSubmit } }),
                      messages: [...messages, { role: 'user', content: nota }],
                  }
                : undefined,
    });
    if (!enviado) {
        const c = (r.toolCalls || []).find((x) => x.toolName === nomeSubmit);
        enviado = c?.input || null;
    }
    const u = r.totalUsage || r.usage || {};
    return { enviado, passos: r.steps?.length ?? 0, ms: Date.now() - t0, tokensIn: u.inputTokens || 0, tokensOut: u.outputTokens || 0, cache: u.cachedInputTokens || u.inputTokenDetails?.cacheReadTokens || 0 };
}

const comRetry = async (fn) => {
    let ultimo;
    for (let t = 0; t < 4; t++) {
        try { return await fn(); } catch (e) { ultimo = e; await new Promise((ok) => setTimeout(ok, 10000 * 2 ** t)); }
    }
    throw ultimo;
};

// ---------- grupos do stage 2 ----------
function gruposDoPr(cid, raw, st2, M, D) {
    const t = raw.trace;
    const itens = [];
    (t.preFilterCandidates || []).forEach((c, i) => { if (['G', 'M3'].includes(tec(c.producedBy || ''))) itens.push({ c, src: 'M', col: i }); });
    (t.verification?.decisions || []).filter((d) => d.action === 'drop' && d.droppedFinding)
        .map((d) => ({ ...d.droppedFinding, relevantFile: d.relevantFile }))
        .forEach((c, i) => { if (['G', 'M3'].includes(tec(c.producedBy || ''))) itens.push({ c, src: 'D', col: i }); });
    const porIndice = new Map((st2.decisoes?.keep || []).map((k) => [Number(k?.index), k]));
    return (st2.kept || []).map((k) => {
        const it = itens[k];
        if (!it) return null;
        const e = porIndice.get(k);
        const membros = [k, ...((e && Array.isArray(e.mergedFrom) ? e.mergedFrom : []).filter((x) => itens[x]))];
        const fundido = membros.length > 1 && e?.mergedDescription;
        return {
            k,
            file: it.c.relevantFile,
            start: it.c.relevantLinesStart,
            end: it.c.relevantLinesEnd,
            text: fundido ? e.mergedDescription : it.c.suggestionContent,
            fundido: !!fundido,
            origens: [...new Set(membros.map((x) => tec(itens[x].c.producedBy || '')))],
            col: fundido ? null : { src: it.src, col: it.col },
        };
    }).filter(Boolean);
}

(async () => {
    const dir = path.join(__dirname, 'pools', POOL);
    const M = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', `matriz-${POOL}.json`), 'utf8'));
    const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', `matriz-descartados-${POOL}.json`), 'utf8'));
    const ST2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'reducer', `${SUFIXO}-heavy-pre-semdrop-desc.json`), 'utf8')).prs;
    const vars = {};
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const L30 = JSON.parse(fs.readFileSync(path.join(__dirname, 'light-30.json'), 'utf8'));
    const model = buildModel(MODELO);
    const chave = loadJudgeKey();
    // As descricoes fundidas sao julgadas uma vez so e reaproveitadas nos 12 testes.
    const cacheJuizArq = path.join(__dirname, 'results', 'verify', `juiz-fundidas-${SUFIXO}.json`);
    fs.mkdirSync(path.dirname(cacheJuizArq), { recursive: true });
    // Varias configuracoes do mesmo modelo rodam em paralelo e dividem este
    // cache: leitura tolerante e escrita atomica (tmp + rename).
    let cacheJuiz = {};
    try { cacheJuiz = JSON.parse(fs.readFileSync(cacheJuizArq, 'utf8')); } catch {}
    console.log(`[verify] ${descreveModelo(MODELO)} · ${UNIDADE} · teto ${UNIDADE === 'pr' ? 'sem' : TETO} · ${MODO} · grafo ${GRAFO ? 'sim' : 'nao'}`);

    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { prs: {} };
    const fila = L30.filter((c) => (!SO.length || SO.includes(c)) && ST2[c] && !ST2[c].erro && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, `${cid}.raw.txt`), 'utf8'));
        const gs = (M[cid] || D[cid]).goldens;
        const grupos = gruposDoPr(cid, raw, ST2[cid], M, D);
        // Vetor de confianca do juiz por grupo: a coluna da matriz, ou o juiz sobre a descricao fundida.
        for (const g of grupos) {
            if (g.col) {
                const m = g.col.src === 'M' ? M[cid] : D[cid];
                g.confs = gs.map((_, gi) => m?.conf?.[gi]?.[g.col.col] || 0);
            } else {
                const ch = `${cid}|${crypto.createHash('sha1').update(g.text).digest('hex')}`;
                if (!cacheJuiz[ch]) {
                    cacheJuiz[ch] = await Promise.all(gs.map(async (gg) => {
                        if (!CORE.has(gg.category)) return 0;
                        const v = await matchCommentDetailed(chave, gg.comment, g.text);
                        return v?.match ? v.confidence ?? 0 : 0;
                    }));
                }
                g.confs = cacheJuiz[ch];
            }
        }
        // Gate: so grupo vindo apenas do G, em arquivo que o G nao abriu com readFile.
        const lidosG = new Set((raw.trace.toolCalls || []).filter((x) => (x.tool || x.name) === 'readFile').map((x) => norm(x.args?.path || x.input?.path)));
        const lido = (f) => { const n = norm(f); for (const s of lidosG) if (s === n || s.endsWith('/' + n) || n.endsWith('/' + s)) return true; return false; };
        for (const g of grupos) g.elegivelGate = g.origens.length === 1 && g.origens[0] === 'G' && !lido(g.file);

        const h = await prepareRepo(vars[cid], `${cid}-ver-${process.pid}`);
        if (!h) { res.prs[cid] = { erro: 'sem repo' }; return; }
        try {
            const cmd = new LocalRepoCommands(h.dir);
            let grafo = null;
            if (GRAFO) {
                const { buildPrCallGraph } = require('./build-pr-callgraph');
                const cg = await buildPrCallGraph(vars[cid], h.dir, cid, () => {});
                grafo = cg?.xml || null;
                if (!grafo) throw new Error('grafo vazio');
            }
            const custo = { passos: 0, ms: 0, tokensIn: 0, tokensOut: 0, cache: 0, sessoes: 0 };
            const soma = (s) => { custo.passos += s.passos; custo.ms += s.ms; custo.tokensIn += s.tokensIn; custo.tokensOut += s.tokensOut; custo.cache += s.cache; custo.sessoes++; };
            const veredito = (x) => (MODO === 'score' ? { score: Number(x?.score) } : { keep: x?.keep !== false });

            if (UNIDADE === 'sugestao') {
                let j = 0;
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (j < grupos.length) {
                        const g = grupos[j++];
                        const s = await comRetry(() => sessao(model, cmd, system, promptSugestao(g, grafo, TETO), TETO, MODO === 'score' ? SCORE_ITEM : KEEP_ITEM, 'submitVerdict', 1));
                        soma(s);
                        g.v = s.enviado ? veredito(s.enviado) : null;
                        // Gate: no keep so re-verifica o que ficou; no score, re-pontua tudo que e elegivel.
                        if (g.elegivelGate && (MODO === 'score' || g.v?.keep !== false)) {
                            const tg = TETO_GATE[TETO] || TETO;
                            const s2 = await comRetry(() => sessao(model, cmd, system, promptSugestao(g, grafo, tg), tg, MODO === 'score' ? SCORE_ITEM : KEEP_ITEM, 'submitVerdict', 1));
                            soma(s2);
                            if (s2.enviado) { g.v = veredito(s2.enviado); g.gate = true; }
                        }
                    }
                }));
            } else {
                const schema = (item) => ({
                    type: 'object',
                    properties: { verdicts: { type: 'array', items: { ...item, properties: { index: { type: 'number' }, ...item.properties }, required: ['index', ...item.required] } } },
                    required: ['verdicts'],
                });
                const aplica = (lista, alvo) => {
                    for (const x of lista || []) {
                        const g = alvo[Number(x?.index)];
                        if (g) g.v = veredito(x);
                    }
                };
                const s = await comRetry(() => sessao(model, cmd, sistemaPorPr(system), promptPr(grupos, grafo), SEM_TETO, schema(MODO === 'score' ? SCORE_ITEM : KEEP_ITEM), 'submitVerdicts', grupos.length));
                soma(s);
                aplica(s.enviado?.verdicts, grupos);
                const gate = grupos.filter((g) => g.elegivelGate && (MODO === 'score' || g.v?.keep !== false));
                if (gate.length) {
                    const s2 = await comRetry(() => sessao(model, cmd, sistemaPorPr(system), promptPr(gate, grafo), SEM_TETO, schema(MODO === 'score' ? SCORE_ITEM : KEEP_ITEM), 'submitVerdicts', gate.length));
                    soma(s2);
                    aplica(s2.enviado?.verdicts, gate);
                    gate.forEach((g) => { g.gate = true; });
                }
            }
            res.prs[cid] = {
                grupos: grupos.map((g) => ({ k: g.k, fundido: g.fundido, origens: g.origens, gate: !!g.gate, elegivelGate: g.elegivelGate, v: g.v || null, confs: g.confs, cat: gs.map((x) => x.category) })),
                custo,
            };
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
        } finally {
            await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res));
            try {
                let atual = {};
                try { atual = JSON.parse(fs.readFileSync(cacheJuizArq, 'utf8')); } catch {}
                const tmp = `${cacheJuizArq}.${process.pid}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify({ ...atual, ...cacheJuiz }));
                fs.renameSync(tmp, cacheJuizArq);
            } catch {}
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));

    // ---------- placar ----------
    const total = L30.reduce((a, c) => a + ((M[c] || D[c])?.goldens || []).filter((g) => CORE.has(g.category)).length, 0);
    const placar = (fica) => {
        let gold = 0, cand = 0, tp = 0;
        for (const p of Object.values(res.prs)) {
            if (!p.grupos) continue;
            const vivos = p.grupos.filter(fica);
            cand += vivos.length;
            const venceu = new Set();
            (p.grupos[0]?.cat || []).forEach((cat, gi) => {
                if (!CORE.has(cat)) return;
                let b = 0, q = -1;
                vivos.forEach((g, k) => { if ((g.confs[gi] || 0) > b) { b = g.confs[gi]; q = k; } });
                if (q >= 0) { gold++; venceu.add(q); }
            });
            tp += venceu.size;
        }
        const fp = cand - tp;
        return { gold, recall: gold / total, cand, precisao: gold + fp ? gold / (gold + fp) : 0 };
    };
    const custos = Object.values(res.prs).filter((p) => p.custo).map((p) => p.custo);
    const media = (k) => custos.reduce((a, c) => a + c[k], 0) / (custos.length || 1);
    const resumo = {
        modelo: MODELO, pool: POOL, unidade: UNIDADE, teto: UNIDADE === 'pr' ? null : TETO, modo: MODO, grafo: GRAFO, total,
        prs: Object.values(res.prs).filter((p) => p.grupos).length,
        erros: Object.values(res.prs).filter((p) => p.erro).length,
        semVeredito: Object.values(res.prs).reduce((a, p) => a + (p.grupos || []).filter((g) => !g.v).length, 0),
        gate: Object.values(res.prs).reduce((a, p) => a + (p.grupos || []).filter((g) => g.gate).length, 0),
        antes: placar(() => true),
        custoPorPr: { passos: media('passos'), seg: media('ms') / 1000, tokensIn: media('tokensIn'), tokensOut: media('tokensOut'), cache: media('cache'), sessoes: media('sessoes') },
    };
    if (MODO === 'keep') resumo.depois = placar((g) => !g.v || g.v.keep !== false);
    else resumo.porLimiar = Object.fromEntries([0, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90].map((t) => [t, placar((g) => !g.v || !Number.isFinite(g.v.score) || g.v.score >= t)]));
    res.resumo = resumo;
    fs.writeFileSync(OUT, JSON.stringify(res));
    console.log(JSON.stringify(resumo));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
