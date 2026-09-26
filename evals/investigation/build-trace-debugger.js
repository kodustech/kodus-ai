#!/usr/bin/env node
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * TRACE DEBUGGER — uma página HTML por rodada, que responde para cada PR o que
 * entrou, como foi processado em cada fase, o que saiu e onde deu errado.
 *
 * Por que ela existe: três bugs de medição desta investigação ficaram invisíveis
 * até alguém ler um dump na mão — um adapter derrubando quatro parâmetros em
 * silêncio, um shard herdando o prompt inteiro do generalista, e um corpus
 * entregando seis arquivos de um PR de 127. Todos produziram número que parecia
 * bom. Aqui as checagens são CALCULADAS, não afirmadas.
 *
 * Fontes, todas opcionais menos a primeira — a página abre com o que houver e
 * diz "não disponível" no que faltar, em vez de quebrar:
 *   pools/<run>/*.raw.txt      geração + reducer em fluxo (obrigatório)
 *   results/matriz-<run>.json  judge: casamento candidato x golden
 *   results/seletor-<run>.json atribuidor offline
 *   results/score2-<run>.json  veracidade offline
 *   results/verify-<run>.json  verify offline
 *
 *   node build-trace-debugger.js --run=<nome> [--out=<arquivo.html>]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { repoDirFor } = require('./prepare-repo');
try { require('dotenv').config({ path: path.join(__dirname, '../../.env') }); } catch {}
try { require('dotenv').config({ path: path.join(__dirname, '../../.env.local'), override: true }); } catch {}

const RESULTS = path.join(__dirname, 'results');
const POOLS = process.env.POOL_ROOT || path.join(__dirname, 'pools');
const DATASETS = path.join(__dirname, 'datasets');
const LANGFUSE = (process.env.LANGFUSE_BASE_URL || 'https://us.cloud.langfuse.com').replace(/\/$/, '');
const CORE = new Set(['bug','security','concurrency','data','api','perf','test_gap','doc_defect']);
const SEVN = { low: 0.25, medium: 0.5, high: 0.75, critical: 1.0 };

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.split('=').slice(1).join('=') : d;
};
const RUN = arg('run') || arg('dump');
if (!RUN) { console.error('uso: build-trace-debugger.js --run=<nome>'); process.exit(1); }
const OUT = arg('out', path.join(RESULTS, `debugger-${RUN}.html`));

const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => Number(n || 0).toLocaleString('pt-BR');
const pct = (n) => `${(Number(n || 0) * 100).toFixed(1)}%`;
const ms = (v) => (v == null ? '—' : v < 1000 ? `${Math.round(v)}ms` : v < 90000 ? `${(v / 1000).toFixed(1)}s` : `${(v / 60000).toFixed(1)}min`);
const curto = (f) => String(f || '').split('/').slice(-1)[0];

// ---------------------------------------------------------------- fontes
const lerJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const opcional = (nome) => lerJson(path.join(RESULTS, `${nome}-${RUN}.json`));

const MATRIZ = opcional('matriz');
const SELETOR = (opcional('seletor') || {}).saida || null;
const SCORE2 = (opcional('score2') || {}).saida || null;
const VERIFY = (opcional('verify') || {}).saida || null;
const RUNJSON = opcional('run');

const OS30 = lerJson(path.join(__dirname, 'light-30.json')) || [];
const GOLDENS = (() => {
    const g = lerJson(path.join(__dirname, '../benchmark-sets/v002/goldens.json'));
    return g ? Object.fromEntries(g.prs.map((p) => [p.caseId, p.comments || []])) : {};
})();
const DATASET = (() => {
    const out = new Map();
    try {
        for (const f of fs.readdirSync(DATASETS)) {
            if (!f.endsWith('.json')) continue;
            const v = lerJson(path.join(DATASETS, f));
            const vars = v && v[0] && v[0].vars;
            if (vars && vars.caseId) out.set(vars.caseId, vars);
        }
    } catch {}
    return out;
})();

function carregarDumps() {
    const dir = path.join(POOLS, RUN);
    if (!fs.existsSync(dir)) { console.error(`não achei ${dir}`); process.exit(1); }
    const out = new Map();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.raw.txt'))) {
        const j = lerJson(path.join(dir, f));
        if (j && j.caseId) out.set(j.caseId, j);
    }
    return out;
}
const DUMPS = carregarDumps();

/** Verdade de campo: o que o PR mexeu, direto do clone. */
function gitArquivos(vars) {
    try {
        const repo = repoDirFor(vars.repositoryFullName);
        if (!repo || !fs.existsSync(repo) || !vars.benchmarkHeadRef) return null;
        let base = vars.benchmarkBaseRef;
        if (!base) base = execFileSync('git', ['-C', repo, 'rev-parse', `${vars.benchmarkHeadRef}^`], { encoding: 'utf8' }).trim();
        const linhas = execFileSync('git', ['-C', repo, 'diff', '--name-status', '--no-renames', base, vars.benchmarkHeadRef],
            { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\n').filter(Boolean);
        return { total: linhas.length, revisaveis: linhas.filter((l) => !l.startsWith('D')).length };
    } catch { return null; }
}

// ------------------------------------------------- casamento com o gabarito
/** Para um PR: quem é o dono de cada golden entre os candidatos, pela regra da
 *  métrica (maior confiança vence). Devolve null quando não há judge. */
function donosDoGolden(cid, cands) {
    const m = MATRIZ && MATRIZ[cid];
    if (!m) return null;
    const core = [];
    const dono = new Map();
    // `cobre` percorre TODOS os goldens, nao so os core: um candidato que venceu
    // um golden fora do perfil acertou alguma coisa e nao e falso positivo. E a
    // mesma regra do relatorio.py — se as duas divergirem, a pagina e o relatorio
    // dao numeros diferentes para a mesma rodada, que e pior que estar errado.
    const cobre = new Set();
    for (let gi = 0; gi < m.goldens.length; gi++) {
        const ehCore = CORE.has(m.goldens[gi].category);
        if (ehCore) core.push(gi);
        const linha = m.conf[gi] || [];
        let melhor = 0, quem = -1;
        for (let k = 0; k < cands.length; k++) {
            const x = linha[k] || 0;
            if (x > melhor) { melhor = x; quem = k; }
        }
        if (quem < 0) continue;
        cobre.add(quem);
        if (ehCore) dono.set(gi, { cand: quem, conf: melhor });
    }
    return { goldens: m.goldens, core, dono, cobre };
}

// ---------------------------------------------------------------- por PR
function montarPR(cid) {
    const j = DUMPS.get(cid);
    const vars = DATASET.get(cid);
    const gold = GOLDENS[cid] || [];
    const goldCore = gold.filter((g) => CORE.has(g.category)).length;
    if (!j) {
        return { cid, ausente: true, goldensCore: goldCore, goldensTotal: gold.length,
                 erro: 'PR não produziu dump — a geração falhou ou nem chegou a rodar' };
    }
    const t = j.trace || {};
    const p = t.pipeline || {};
    const cands = t.preFilterCandidates || [];
    const red = (t.dedup || {}).reducer || null;
    const passes = t.recallPasses || [];
    const postados = j.findings || [];

    // filtro de contrato, recalculado aqui para poder dizer QUEM caiu e por quê
    const reprovados = [];
    cands.forEach((c, i) => {
        const sev = String(c.severity || '').toLowerCase();
        const motivos = [];
        if (!(sev in SEVN)) motivos.push(`severidade "${c.severity || '(vazia)'}" fora da escala`);
        if (!c.reason) motivos.push('sem reason (percurso)');
        if (motivos.length) reprovados.push({ i, c, motivos });
    });
    const aprovados = cands.map((c, i) => i).filter((i) => !reprovados.some((r) => r.i === i));

    const gj = donosDoGolden(cid, cands);
    const tempoPasses = passes.reduce((a, r) => a + (r.ms || 0), 0);

    return {
        cid, vars, trace: t, pipeline: p, cands, reprovados, aprovados, red, passes, postados,
        judge: gj,
        goldensCore: gj ? gj.core.length : goldCore,
        goldensTotal: gold.length,
        wall: t.reviewWallMs || null,
        tempoAgente: tempoPasses,
        usage: t.usage || {},
        seletor: SELETOR ? SELETOR[cid] : null,
        score2: SCORE2 ? SCORE2[cid] : null,
        verify: VERIFY ? VERIFY[cid] : null,
        git: vars ? gitArquivos(vars) : null,
    };
}

const PRS = OS30.length ? OS30.map(montarPR) : [...DUMPS.keys()].map(montarPR);

// ------------------------------------------------------------- agregados
function agregar() {
    const a = {
        prs: PRS.length, comDump: PRS.filter((x) => !x.ausente).length,
        goldensCore: 0, cands: 0, reprovados: 0, grupos: 0, postados: 0,
        tpPre: 0, fpPre: 0, tpPos: 0, fpPos: 0,
        tokensIn: 0, tokensCache: 0, tokensOut: 0,
        wall: [], agente: [], porAgente: new Map(), erros: [],
        attributorMs: [], veracityMs: [],
    };
    for (const x of PRS) {
        a.goldensCore += x.goldensCore || 0;
        if (x.ausente) { a.erros.push({ cid: x.cid, fase: 'geração', msg: x.erro }); continue; }
        a.cands += x.cands.length;
        a.reprovados += x.reprovados.length;
        a.grupos += x.red ? x.red.groupsCount || 0 : 0;
        a.postados += x.postados.length;
        a.tokensIn += (x.usage.inputTokens || 0) - (x.usage.cacheReadTokens || 0);
        a.tokensCache += x.usage.cacheReadTokens || 0;
        a.tokensOut += x.usage.outputTokens || 0;
        if (x.wall) a.wall.push(x.wall);
        if (x.tempoAgente) a.agente.push(x.tempoAgente);
        if (x.red && x.red.attributorMs) a.attributorMs.push(x.red.attributorMs);
        if (x.red && x.red.veracityMs) a.veracityMs.push(x.red.veracityMs);
        for (const r of x.passes) {
            const k = r.label;
            const v = a.porAgente.get(k) || { passes: 0, achados: 0, steps: 0, tools: 0, ms: 0, vazias: 0 };
            v.passes++; v.achados += r.added || 0; v.steps += r.steps || 0;
            v.tools += r.toolCalls || 0; v.ms += r.ms || 0; if (!r.added) v.vazias++;
            a.porAgente.set(k, v);
        }
        // erros declarados
        for (const w of x.trace.warnings || []) a.erros.push({ cid: x.cid, fase: 'geração', msg: typeof w === 'string' ? w : JSON.stringify(w) });
        if (x.red && x.red.status && x.red.status !== 'success')
            a.erros.push({ cid: x.cid, fase: 'reducer', msg: `status ${x.red.status}` });
        if (x.seletor && x.seletor.erro) a.erros.push({ cid: x.cid, fase: 'atribuidor', msg: x.seletor.erro });
        if (x.verify) for (const g of x.verify.grupos || [])
            if (g.erro) a.erros.push({ cid: x.cid, fase: 'verify', msg: g.rationale || 'falhou' });
        // metricas
        if (x.judge) {
            a.tpPre += x.judge.dono.size;
            a.fpPre += x.cands.length - x.judge.cobre.size;
            // pos-reducer: golden coberto por grupo mantido
            if (x.red && x.red.groups) {
                const mantidos = x.red.groups.filter((g) => g.kept);
                const idxMantidos = new Set(mantidos.flatMap((g) => g.indices || []));
                const cobertos = new Set();
                let semGolden = 0;
                for (const g of mantidos) {
                    const temGolden = (g.indices || []).some((i) => [...x.judge.dono.values()].some((d) => d.cand === x.aprovados[i]));
                    if (temGolden) for (const [gi, d] of x.judge.dono) if ((g.indices || []).some((i) => x.aprovados[i] === d.cand)) cobertos.add(gi);
                    else semGolden++;
                }
                a.tpPos += cobertos.size; a.fpPos += semGolden;
            }
        }
    }
    return a;
}
const AG = agregar();

const f1 = (tp, fp, tot) => { const r = tp / Math.max(1, tot), p = tp / Math.max(1, tp + fp);
    return { r, p, f1: (2 * r * p) / Math.max(1e-9, r + p), f2: (5 * r * p) / Math.max(1e-9, 4 * p + r) }; };
const stats = (arr) => { if (!arr.length) return null; const v = [...arr].sort((a, b) => a - b);
    return { min: v[0], med: v[Math.floor(v.length / 2)], avg: v.reduce((a, b) => a + b, 0) / v.length, max: v[v.length - 1] }; };

// ============================================================ apresentação
const CSS = `
:root{
  --bg:#f6f7f9; --card:#fff; --ink:#15181d; --ink2:#5a6573; --ink3:#8b95a3;
  --line:#e2e6eb; --line2:#eef1f4; --accent:#2f5bd6; --accent-soft:#eaf0fe;
  --ok:#1a7f4b; --ok-soft:#e6f5ec; --warn:#a56a00; --warn-soft:#fdf3e0;
  --bad:#b3261e; --bad-soft:#fdeceb; --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0f1115; --card:#171a20; --ink:#e7eaef; --ink2:#a4adba; --ink3:#727c8a;
  --line:#262b33; --line2:#1e222a; --accent:#7ea2ff; --accent-soft:#1a2340;
  --ok:#5bd08c; --ok-soft:#13291d; --warn:#e0a63a; --warn-soft:#2b2110;
  --bad:#ff8b82; --bad-soft:#2d1614;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
h2{font-size:15px;margin:34px 0 12px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink2)}
h3{font-size:14px;margin:18px 0 8px}
a{color:var(--accent)}
.sub{color:var(--ink2);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.grid{display:grid;gap:12px}
.g4{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}
.g3{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
.g2{grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.kpi .n{font-size:24px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.kpi .l{color:var(--ink2);font-size:12px;margin-top:2px}
.kpi .h{color:var(--ink3);font-size:11px;margin-top:6px;line-height:1.4}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{text-align:left;font-weight:600;color:var(--ink2);font-size:12px;text-transform:uppercase;
   letter-spacing:.04em;padding:8px 10px;border-bottom:1px solid var(--line)}
td{padding:7px 10px;border-bottom:1px solid var(--line2);vertical-align:top}
tr:last-child td{border-bottom:0}
td.n,th.n{text-align:right}
.tblwrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:10px}
.mono{font-family:var(--mono);font-size:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;
  border:1px solid transparent;white-space:nowrap}
.pill.ok{background:var(--ok-soft);color:var(--ok)}
.pill.warn{background:var(--warn-soft);color:var(--warn)}
.pill.bad{background:var(--bad-soft);color:var(--bad)}
.pill.mute{background:var(--line2);color:var(--ink3)}
.pill.acc{background:var(--accent-soft);color:var(--accent)}
.muted{color:var(--ink3)}
.funnel{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch}
.step{flex:1 1 130px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;position:relative}
.step .n{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.step .l{font-size:12px;color:var(--ink2)}
.step .d{font-size:11px;color:var(--ink3);margin-top:4px;line-height:1.4}
.step .arrow{position:absolute;right:-13px;top:50%;transform:translateY(-50%);color:var(--ink3);font-size:15px;z-index:1}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:8px}
details[open]{border-color:var(--accent)}
summary{cursor:pointer;padding:11px 14px;list-style:none;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
summary::-webkit-details-marker{display:none}
summary:hover{background:var(--line2)}
summary .nome{font-weight:600;flex:1 1 300px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body{padding:4px 14px 18px;border-top:1px solid var(--line2)}
.fase{margin:16px 0 0;padding:12px 14px;border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.fase>.t{font-weight:600;font-size:13px;display:flex;gap:8px;align-items:center;margin-bottom:2px}
.fase>.io{font-size:11.5px;color:var(--ink3);margin-bottom:10px;line-height:1.5}
.fase.prod>.t::before{content:"PRODUÇÃO";font-size:9.5px;font-weight:700;letter-spacing:.06em;
  background:var(--accent-soft);color:var(--accent);padding:2px 6px;border-radius:4px}
.fase.off>.t::before{content:"OFFLINE";font-size:9.5px;font-weight:700;letter-spacing:.06em;
  background:var(--line2);color:var(--ink3);padding:2px 6px;border-radius:4px}
.kv{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12.5px;color:var(--ink2);margin-bottom:8px}
.kv b{color:var(--ink);font-weight:600}
.snippet{font-family:var(--mono);font-size:11.5px;background:var(--line2);border-radius:6px;
  padding:8px 10px;margin:4px 0;white-space:pre-wrap;word-break:break-word;color:var(--ink2)}
.bar{height:6px;border-radius:3px;background:var(--line2);overflow:hidden;min-width:70px}
.bar>i{display:block;height:100%;background:var(--accent)}
.note{border-left:3px solid var(--accent);padding:8px 12px;background:var(--accent-soft);
  border-radius:0 6px 6px 0;font-size:12.5px;color:var(--ink);margin:10px 0}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.toolbar button{font:inherit;font-size:12px;padding:5px 12px;border-radius:999px;cursor:pointer;
  border:1px solid var(--line);background:var(--card);color:var(--ink2)}
.toolbar button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
@media(max-width:640px){.wrap{padding:18px 14px 60px}.step .arrow{display:none}}
`;

const pill = (cls, txt) => `<span class="pill ${cls}">${esc(txt)}</span>`;
const bar = (v, max) => `<span class="bar"><i style="width:${Math.max(0, Math.min(100, (v / Math.max(1, max)) * 100)).toFixed(0)}%"></i></span>`;

function cabecalho() {
    const modelo = RUNJSON && RUNJSON.model ? RUNJSON.model : ([...DUMPS.values()][0] || {}).trace?.modelServed?.modelId || '—';
    const quando = (() => { try { return new Date(fs.statSync(path.join(POOLS, RUN)).mtimeMs).toLocaleString('pt-BR'); } catch { return '—'; } })();
    const temJudge = !!MATRIZ, temVerify = !!VERIFY, temScore2 = !!SCORE2;
    return `
<h1>${esc(RUN)}</h1>
<p class="sub">Trace da rodada — o que entrou, como foi processado e o que saiu, PR a PR.</p>
<div class="grid g4">
  <div class="kpi"><div class="n">${esc(modelo)}</div><div class="l">modelo do review</div></div>
  <div class="kpi"><div class="n">${AG.comDump}/${AG.prs}</div><div class="l">PRs com dump</div>
    <div class="h">${AG.comDump === AG.prs ? 'conjunto completo' : 'conjunto INCOMPLETO — não compare com outra rodada'}</div></div>
  <div class="kpi"><div class="n">${num(AG.goldensCore)}</div><div class="l">goldens core no conjunto</div>
    <div class="h">o denominador de todo recall desta página</div></div>
  <div class="kpi"><div class="n" style="font-size:15px;font-weight:500">${quando}</div><div class="l">gerada em</div></div>
</div>
<div class="grid g4" style="margin-top:12px">
  <div class="kpi"><div class="n">${temJudge ? pill('ok', 'sim') : pill('bad', 'não')}</div><div class="l">judge disponível</div>
    <div class="h">sem ele não há recall nem precisão, só contagem</div></div>
  <div class="kpi"><div class="n">${temScore2 ? pill('ok', 'sim') : pill('mute', 'não')}</div><div class="l">veracidade offline</div></div>
  <div class="kpi"><div class="n">${temVerify ? pill('ok', 'sim') : pill('mute', 'não')}</div><div class="l">verify offline</div>
    <div class="h">fase experimental, fora de produção</div></div>
  <div class="kpi"><div class="n">${SELETOR ? pill('ok', 'sim') : pill('mute', 'não')}</div><div class="l">atribuidor offline</div></div>
</div>`;
}

function comoLer() {
    return `
<h2>Como esta página funciona</h2>
<div class="card">
<p style="margin-top:0">Uma review passa por <b>seis fases que rodam em produção</b>. Depois dela, o
harness roda mais três <b>só para medir</b> — elas não existem no produto e nunca influenciam o
resultado que um desenvolvedor receberia no PR.</p>

<div class="fase prod"><div class="t">1 · Microagentes</div>
<div class="io"><b>entra:</b> o diff completo do PR · <b>sai:</b> achados brutos, no máximo 2 por agente ·
13 agentes em paralelo, cada um com uma única classe de defeito e nada mais.</div></div>

<div class="fase prod"><div class="t">2 · Simulação mental</div>
<div class="io"><b>entra:</b> o diff + a lista do que a fase 1 levantou · <b>sai:</b> mais achados ·
roda depois, para gastar orçamento em terreno que ninguém cobriu.</div></div>

<div class="fase prod"><div class="t">3 · Filtro de contrato <span class="pill mute">determinístico</span></div>
<div class="io"><b>entra:</b> todos os achados · <b>sai:</b> os que têm <code>reason</code> e severidade na escala
(low/medium/high/critical). Sem LLM. Achado sem percurso é anotação, não defeito proposto.</div></div>

<div class="fase prod"><div class="t">4 · Atribuidor <span class="pill acc">1 chamada por PR</span></div>
<div class="io"><b>entra:</b> os achados aprovados + o diff · <b>sai:</b> grupos de duplicata, um representante
por grupo e uma nota 0-100 de "vale postar isto".</div></div>

<div class="fase prod"><div class="t">5 · Veracidade <span class="pill acc">1 chamada por PR</span></div>
<div class="io"><b>entra:</b> o representante de cada grupo + o diff · <b>sai:</b> 0-100 de "a alegação é
verdadeira sobre este código". Deliberadamente cega a importância — é o que a torna um sinal
independente da nota do atribuidor.</div></div>

<div class="fase prod"><div class="t">6 · Fórmula, cota e limiar <span class="pill mute">determinístico</span></div>
<div class="io"><b>entra:</b> nota, veracidade e mais seis termos por grupo · <b>sai:</b> uma probabilidade.
Os grupos são ordenados, cortados na cota por PR e no limiar. O que sobra é postado.</div></div>

<div class="fase off"><div class="t">Judge</div>
<div class="io">Casa cada candidato com cada golden do gabarito. É o instrumento de medida — julga
<b>todos</b> os candidatos, não só os representantes.</div></div>

<div class="fase off"><div class="t">Verify</div>
<div class="io">Um agente por grupo, com grep e readFile no repositório real, devolvendo 0-100.
<b>Experimento.</b> Nunca esteve em produção; medido como não pagando o próprio custo.</div></div>

<div class="note"><b>Como ler os números.</b> Piso de ruído: <b>0,026 de F1</b> — diferença menor que isso
não é efeito. A variância entre duas rodadas da mesma configuração chega a <b>8pp de recall</b>, então
compare braços da mesma rodada sempre que puder.</div>
</div>`;
}

function funil() {
    const brutos = AG.cands, aprov = AG.cands - AG.reprovados;
    const passos = [
        { n: AG.goldensCore, l: 'goldens a achar', d: 'o gabarito do conjunto' },
        { n: brutos, l: 'achados brutos', d: 'saída das fases 1 e 2' },
        { n: aprov, l: 'passam no contrato', d: `${AG.reprovados} reprovados` },
        { n: AG.grupos, l: 'grupos', d: 'depois do atribuidor' },
        { n: AG.postados, l: 'comentários postados', d: 'depois da fórmula' },
    ];
    return `<h2>O funil da rodada</h2><div class="funnel">${passos.map((s, i) => `
      <div class="step"><div class="n">${num(s.n)}</div><div class="l">${esc(s.l)}</div>
      <div class="d">${esc(s.d)}</div>${i < passos.length - 1 ? '<span class="arrow">→</span>' : ''}</div>`).join('')}</div>`;
}

function metricas() {
    if (!MATRIZ) return `<h2>Métricas</h2><div class="card"><p class="muted" style="margin:0">
      Sem <code>results/matriz-${esc(RUN)}.json</code> não dá para dizer o que é acerto. Rode o judge
      (<code>matriz-prefilter.js --dump=${esc(RUN)}</code>) e gere a página de novo.</p></div>`;
    const pre = f1(AG.tpPre, AG.fpPre, AG.goldensCore);
    const pos = f1(AG.tpPos, AG.fpPos, AG.goldensCore);
    const linha = (nome, m, tp, fp, expl) => `<tr><td><b>${nome}</b><div class="muted" style="font-size:11.5px">${expl}</div></td>
      <td class="n">${tp}</td><td class="n">${fp}</td><td class="n">${pct(m.r)}</td>
      <td class="n">${pct(m.p)}</td><td class="n"><b>${m.f1.toFixed(3)}</b></td><td class="n">${m.f2.toFixed(3)}</td></tr>`;
    return `<h2>Métricas</h2><div class="tblwrap"><table>
      <thead><tr><th>estágio</th><th class="n">tp</th><th class="n">fp</th><th class="n">recall</th>
      <th class="n">precisão</th><th class="n">F1</th><th class="n">F2</th></tr></thead><tbody>
      ${linha('Pré-reducer', pre, AG.tpPre, AG.fpPre, 'cada achado bruto contaria como um comentário postado')}
      ${AG.tpPos || AG.fpPos ? linha('Pós-reducer', pos, AG.tpPos, AG.fpPos, 'o que de fato seria postado no PR') : ''}
      </tbody></table></div>
      <p class="muted" style="font-size:12px">Regra da métrica: por golden vence o candidato de maior confiança;
      candidato que não vence nenhum golden é falso positivo. Perfil <i>core</i>.</p>`;
}

function tabelaAgentes() {
    const linhas = [...AG.porAgente.entries()].sort((a, b) => b[1].achados - a[1].achados);
    const max = Math.max(1, ...linhas.map((l) => l[1].achados));
    return `<h2>Agentes</h2><div class="tblwrap"><table>
      <thead><tr><th>agente</th><th class="n">achados</th><th></th><th class="n">passadas</th>
      <th class="n">vazias</th><th class="n">passos</th><th class="n">ferramentas</th><th class="n">tempo total</th></tr></thead><tbody>
      ${linhas.map(([k, v]) => `<tr>
        <td class="mono">${esc(k.replace(/^micro-/, ''))}</td>
        <td class="n"><b>${v.achados}</b></td><td style="width:90px">${bar(v.achados, max)}</td>
        <td class="n">${v.passes}</td>
        <td class="n">${v.vazias}<span class="muted"> (${Math.round((100 * v.vazias) / Math.max(1, v.passes))}%)</span></td>
        <td class="n">${v.steps}</td><td class="n">${v.tools}</td><td class="n">${ms(v.ms)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted" style="font-size:12px">"Vazias" é o normal: cada agente carrega uma classe só, e a maioria
      dos PRs não tem defeito daquela classe. Zero é resposta válida.</p>`;
}

function recursos() {
    const w = stats(AG.wall), a = stats(AG.agente), at = stats(AG.attributorMs), ve = stats(AG.veracityMs);
    const linha = (n, s, e) => s ? `<tr><td>${n}</td><td class="n">${ms(s.min)}</td><td class="n">${ms(s.med)}</td>
      <td class="n">${ms(s.avg)}</td><td class="n">${ms(s.max)}</td><td class="muted" style="font-size:11.5px">${e}</td></tr>` : '';
    return `<h2>Tempo e tokens</h2>
    <div class="tblwrap" style="margin-bottom:12px"><table>
      <thead><tr><th>fase</th><th class="n">menor</th><th class="n">mediana</th><th class="n">média</th><th class="n">maior</th><th></th></tr></thead>
      <tbody>
        ${linha('Review inteira (parede)', w, 'do início ao fim do PR, sem o judge')}
        ${linha('Soma das passadas', a, 'tempo de agente; as 14 rodam em paralelo, então é maior que a parede')}
        ${linha('Atribuidor', at, '1 chamada por PR')}
        ${linha('Veracidade', ve, '1 chamada por PR')}
      </tbody></table></div>
    <div class="grid g3">
      <div class="kpi"><div class="n">${num(AG.tokensIn)}</div><div class="l">input pago</div>
        <div class="h">fora do cache</div></div>
      <div class="kpi"><div class="n">${num(AG.tokensCache)}</div><div class="l">cache read</div>
        <div class="h">${Math.round((100 * AG.tokensCache) / Math.max(1, AG.tokensCache + AG.tokensIn))}% do input — o prefixo compartilhado pelos agentes</div></div>
      <div class="kpi"><div class="n">${num(AG.tokensOut)}</div><div class="l">output</div></div>
    </div>`;
}

function erros() {
    if (!AG.erros.length) return `<h2>Erros</h2><div class="card"><p style="margin:0">
      ${pill('ok', 'nenhum')} Nenhuma fase reportou falha nesta rodada.</p></div>`;
    return `<h2>Erros <span class="pill bad">${AG.erros.length}</span></h2>
      <div class="tblwrap"><table><thead><tr><th>PR</th><th>fase</th><th>o que aconteceu</th></tr></thead><tbody>
      ${AG.erros.map((e) => `<tr><td class="mono">${esc(e.cid.slice(0, 46))}</td>
        <td>${pill('bad', e.fase)}</td><td>${esc(String(e.msg).slice(0, 220))}</td></tr>`).join('')}
      </tbody></table></div>`;
}

// ----------------------------------------------------------- detalhe do PR
function faseEntrada(x) {
    const p = x.pipeline;
    const g = x.git;
    const gap = g && p.filesInPrompt != null ? g.revisaveis - p.filesInPrompt : null;
    return `<div class="fase"><div class="t">Entrada</div>
    <div class="io">o que o modelo recebeu antes de qualquer chamada</div>
    <div class="kv">
      <span>arquivos no prompt <b>${num(p.filesInPrompt)}</b></span>
      ${g ? `<span>o PR mexeu em <b>${num(g.revisaveis)}</b> revisáveis ${gap > 0 ? pill('bad', `faltaram ${gap}`) : pill('ok', 'todos')}</span>` : ''}
      <span>diff <b>${num(p.userPromptChars)}</b> chars</span>
      <span>system <b>${num(p.systemPromptChars)}</b> chars</span>
      <span>janela <b>${num(p.contextWindowTokens)}</b> tokens</span>
      <span>grafo <b>${p.callGraphChars ? `${num(p.callGraphChars)} chars` : 'não'}</b></span>
      <span>goldens core <b>${x.goldensCore}</b></span>
    </div>
    <div class="kv">
      <span>repositório ${p.repoPrepared ? pill('ok', 'worktree real') : pill('bad', 'replay — as ferramentas não leem o repo')}</span>
      <span>formato do diff ${p.diffSource === 'changedFilesFull' ? pill('ok', 'completo') : pill('bad', String(p.diffSource))}</span>
      ${p.filesWithEmptyPatch ? pill('bad', `${p.filesWithEmptyPatch} arquivo(s) com patch vazio`) : ''}
      ${p.legacyHunkFormat ? pill('bad', 'formato antigo de hunk') : ''}
      ${p.diffBlocksInPrompt != null
          ? `<span>blocos no prompt ${p.diffBlocksInPrompt === p.filesInPrompt
              ? pill('ok', `${p.diffBlocksInPrompt} = arquivos`)
              : pill('bad', `${p.diffBlocksInPrompt} para ${p.filesInPrompt} arquivos`)}</span>`
          : ''}
    </div></div>`;
}

function faseAgentes(x) {
    const micro = x.passes.filter((r) => !/simulate/.test(r.label));
    const sim = x.passes.filter((r) => /simulate/.test(r.label));
    const max = Math.max(1, ...x.passes.map((r) => r.ms || 0));
    const tabela = (arr) => `<div class="tblwrap" style="margin-top:6px"><table>
      <thead><tr><th>agente</th><th class="n">achados</th><th class="n">passos</th><th class="n">ferram.</th>
      <th class="n">leituras</th><th class="n">tokens in</th><th class="n">tempo</th><th></th></tr></thead><tbody>
      ${arr.map((r) => `<tr>
        <td class="mono">${esc(r.label.replace(/^micro-/, ''))}</td>
        <td class="n">${r.added ? `<b>${r.added}</b>` : '<span class="muted">0</span>'}</td>
        <td class="n">${r.steps ?? '—'}</td><td class="n">${r.toolCalls ?? '—'}</td>
        <td class="n">${r.fullFileReads ?? '—'}</td><td class="n">${num(r.inputTokens)}</td>
        <td class="n">${ms(r.ms)}</td><td style="width:80px">${bar(r.ms || 0, max)}</td></tr>`).join('')}
      </tbody></table></div>`;
    return `<div class="fase prod"><div class="t">1 · Microagentes</div>
      <div class="io"><b>entra:</b> o diff · <b>sai:</b> ${micro.reduce((a, r) => a + (r.added || 0), 0)} achados de ${micro.length} agentes</div>
      ${tabela(micro)}</div>
      ${sim.length ? `<div class="fase prod"><div class="t">2 · Simulação mental</div>
      <div class="io"><b>entra:</b> o diff + o que a fase 1 levantou · <b>sai:</b> ${sim.reduce((a, r) => a + (r.added || 0), 0)} achados</div>
      ${tabela(sim)}</div>` : ''}`;
}

function faseContrato(x) {
    const n = x.cands.length, fora = x.reprovados.length;
    return `<div class="fase prod"><div class="t">3 · Filtro de contrato</div>
      <div class="io"><b>entra:</b> ${n} achados · <b>sai:</b> ${n - fora} · determinístico, sem LLM</div>
      ${fora === 0 ? `<span class="muted">Nenhum reprovado.</span>` : `
      <div class="tblwrap"><table><thead><tr><th>achado</th><th>agente</th><th>motivo</th></tr></thead><tbody>
      ${x.reprovados.map((r) => `<tr>
        <td>${esc(String(r.c.oneSentenceSummary || r.c.suggestionContent || '').slice(0, 90))}</td>
        <td class="mono">${esc(String(r.c.producedBy || '').replace(/^micro-/, ''))}</td>
        <td>${r.motivos.map((m) => pill('bad', m)).join(' ')}</td></tr>`).join('')}
      </tbody></table></div>`}</div>`;
}

function faseReducer(x) {
    if (!x.red) return `<div class="fase prod"><div class="t">4-6 · Reducer</div>
      <div class="io">não rodou nesta passada — a rodada não usou o reducer em fluxo</div></div>`;
    const gs = x.red.groups || [];
    const linhas = gs.map((g) => {
        const membros = (g.indices || []).map((i) => x.aprovados[i]).filter((v) => v != null);
        const agentes = [...new Set(membros.map((i) => String((x.cands[i] || {}).producedBy || '').replace(/^micro-/, '')))];
        const vfy = x.verify && (x.verify.grupos || []).find((v) => v.representante === g.representative);
        const ganha = x.judge ? [...x.judge.dono.entries()].filter(([, d]) => membros.includes(d.cand)) : [];
        return `<tr>
          <td>${esc(String(g.summary || '').slice(0, 88))}
            <div class="muted mono" style="font-size:11px">${esc(curto(g.file))}</div></td>
          <td class="n">${g.members}</td>
          <td class="mono" style="font-size:11px">${esc(agentes.join(', ').slice(0, 44))}</td>
          <td class="n">${g.nota ?? '—'}</td>
          <td class="n">${g.veracity ?? '—'}</td>
          ${x.verify ? `<td class="n">${vfy && typeof vfy.score === 'number' ? vfy.score : '<span class="muted">—</span>'}</td>` : ''}
          <td class="n"><b>${g.probability != null ? g.probability.toFixed(3) : '—'}</b></td>
          <td>${g.kept ? pill('ok', 'postado') : pill('mute', 'cortado')}</td>
          <td>${ganha.length ? pill('acc', `acerta ${ganha.length} golden${ganha.length > 1 ? 's' : ''}`) : (x.judge ? pill('mute', 'nenhum golden') : '')}</td>
        </tr>`;
    }).join('');
    return `<div class="fase prod"><div class="t">4-6 · Atribuidor → Veracidade → Fórmula</div>
      <div class="io"><b>entra:</b> ${x.red.inputCount} achados · <b>sai:</b> ${x.red.groupsCount} grupos,
      ${x.red.keptCount} postados · cota ${x.red.quota}, limiar ${x.red.threshold} ·
      atribuidor ${ms(x.red.attributorMs)}, veracidade ${ms(x.red.veracityMs)}</div>
      <div class="tblwrap"><table><thead><tr>
        <th>grupo (representante)</th><th class="n">memb.</th><th>agentes</th>
        <th class="n">nota</th><th class="n">verac.</th>${x.verify ? '<th class="n">verify</th>' : ''}
        <th class="n">prob.</th><th>decisão</th><th>gabarito</th></tr></thead>
      <tbody>${linhas}</tbody></table></div>
      <p class="muted" style="font-size:11.5px;margin:8px 0 0">"nota" é o atribuidor (vale postar?),
      "verac." é a veracidade (a alegação é verdadeira?). A probabilidade combina as duas com mais seis
      termos; o corte é cota ${x.red.quota} por PR e limiar ${x.red.threshold}.</p></div>`;
}

function faseGabarito(x) {
    if (!x.judge) return '';
    const achados = [], perdidos = [];
    for (const gi of x.judge.core) {
        const d = x.judge.dono.get(gi);
        const g = x.judge.goldens[gi];
        (d ? achados : perdidos).push({ g, d });
    }
    const item = (o, ok) => `<tr><td>${ok ? pill('ok', 'alcançado') : pill('bad', 'nunca achado')}</td>
      <td>${esc(String(o.g.comment || '').slice(0, 170))}</td>
      <td class="mono" style="font-size:11px">${esc(o.g.category || '')} · ${esc(o.g.severity || '')}</td>
      <td class="mono" style="font-size:11px">${o.d ? esc(String((x.cands[o.d.cand] || {}).producedBy || '').replace(/^micro-/, '')) : '—'}</td></tr>`;
    return `<div class="fase off"><div class="t">Gabarito <span class="pill mute">medição</span></div>
      <div class="io"><b>entra:</b> os candidatos + os goldens · <b>sai:</b> ${achados.length} de
      ${x.judge.core.length} goldens core alcançados pela geração</div>
      <div class="tblwrap"><table><thead><tr><th></th><th>golden</th><th>classe</th><th>quem achou</th></tr></thead>
      <tbody>${achados.map((o) => item(o, true)).join('')}${perdidos.map((o) => item(o, false)).join('')}</tbody></table></div></div>`;
}

function faseSaida(x) {
    if (!x.postados.length) return `<div class="fase"><div class="t">Saída</div>
      <div class="io">nenhum comentário postado neste PR</div></div>`;
    return `<div class="fase"><div class="t">Saída · ${x.postados.length} comentário(s)</div>
      <div class="io">exatamente o que o desenvolvedor veria no PR</div>
      ${x.postados.map((c) => `<div class="snippet">` +
          `<b>${esc(curto(c.relevantFile))}:${c.relevantLinesStart ?? '?'}</b> · ` +
          `${esc(c.severity || '')} · ${esc(String(c.producedBy || '').replace(/^micro-/, ''))}\n` +
          `${esc(String(c.oneSentenceSummary || c.suggestionContent || '').slice(0, 320))}</div>`).join('')}</div>`;
}

function detalhePR(x) {
    if (x.ausente) {
        return `<details><summary><span class="nome mono">${esc(x.cid)}</span>
          ${pill('bad', 'sem dump')}</summary>
          <div class="body"><div class="note">${esc(x.erro)}. Os ${x.goldensCore} goldens core dele
          continuam no denominador — por isso o recall da rodada cai.</div></div></details>`;
    }
    const lf = x.pipeline.langfuseRunName
        ? `${LANGFUSE}/project?search=${encodeURIComponent(x.pipeline.langfuseRunName)}`
        : null;
    const alcancados = x.judge ? x.judge.dono.size : null;
    const tags = [
        x.red && x.red.keptCount != null ? pill('acc', `${x.red.keptCount} postados`) : '',
        x.judge ? pill(alcancados >= x.judge.core.length ? 'ok' : alcancados ? 'warn' : 'bad',
            `${alcancados}/${x.judge.core.length} goldens`) : '',
        x.reprovados.length ? pill('warn', `${x.reprovados.length} fora do contrato`) : '',
        (x.trace.warnings || []).length ? pill('bad', 'avisos') : '',
        pill('mute', ms(x.wall)),
    ].filter(Boolean).join(' ');
    return `<details data-tem-erro="${(x.trace.warnings || []).length || (x.judge && !x.judge.dono.size) ? '1' : '0'}">
      <summary><span class="nome mono">${esc(x.cid)}</span>${tags}</summary>
      <div class="body">
        <div class="kv" style="margin-top:10px">
          <span>${esc(String((x.vars || {}).repositoryFullName || ''))}</span>
          ${lf ? `<span><a href="${esc(lf)}" target="_blank" rel="noreferrer">ver no Langfuse ↗</a></span>` : ''}
          <span>tokens <b>${num(x.usage.inputTokens)}</b> in / <b>${num(x.usage.outputTokens)}</b> out</span>
          <span>cache <b>${Math.round((100 * (x.usage.cacheReadTokens || 0)) / Math.max(1, x.usage.inputTokens || 1))}%</b></span>
        </div>
        ${faseEntrada(x)}${faseAgentes(x)}${faseContrato(x)}${faseReducer(x)}${faseSaida(x)}${faseGabarito(x)}
      </div></details>`;
}

// ------------------------------------------------------------------ saída
const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trace · ${esc(RUN)}</title><style>${CSS}</style></head><body><div class="wrap">
${cabecalho()}
${comoLer()}
${funil()}
${metricas()}
${tabelaAgentes()}
${recursos()}
${erros()}
<h2>PR a PR</h2>
<div class="toolbar">
  <button id="bAll" aria-pressed="true">todos (${PRS.length})</button>
  <button id="bErr" aria-pressed="false">só com problema</button>
  <button id="bOpen">abrir todos</button>
  <button id="bClose">fechar todos</button>
</div>
<div id="lista">${PRS.map(detalhePR).join('')}</div>
<p class="muted" style="font-size:12px;margin-top:24px">
Gerada por <code>build-trace-debugger.js --run=${esc(RUN)}</code>.
Fontes: <code>pools/${esc(RUN)}/</code>${MATRIZ ? `, <code>matriz-${esc(RUN)}.json</code>` : ''}${SELETOR ? `, <code>seletor-${esc(RUN)}.json</code>` : ''}${SCORE2 ? `, <code>score2-${esc(RUN)}.json</code>` : ''}${VERIFY ? `, <code>verify-${esc(RUN)}.json</code>` : ''}.
</p>
</div><script>
const lista=document.getElementById('lista');
const itens=[...lista.querySelectorAll('details')];
const bAll=document.getElementById('bAll'),bErr=document.getElementById('bErr');
function filtrar(soErro){
  itens.forEach(d=>{d.hidden = soErro && d.dataset.temErro!=='1';});
  bAll.setAttribute('aria-pressed', String(!soErro));
  bErr.setAttribute('aria-pressed', String(soErro));
}
bAll.onclick=()=>filtrar(false);
bErr.onclick=()=>filtrar(true);
document.getElementById('bOpen').onclick=()=>itens.forEach(d=>{if(!d.hidden)d.open=true});
document.getElementById('bClose').onclick=()=>itens.forEach(d=>d.open=false);
</script></body></html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`${PRS.length} PRs · ${AG.erros.length} erro(s) -> ${OUT}`);
