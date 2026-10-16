#!/usr/bin/env node
/**
 * #1821: o fluxo de revisao inteiro num modelo, em light ou heavy mode, com os
 * tokens (input, cache read, output) e o tempo de cada etapa e a regua Martian
 * no fim de cada uma.
 *
 *   light: finder so com o generalista -> dedup -> verify C -> nit protegido
 *   heavy: finder com generalista + lentes M3 -> dedup -> verify C -> nit protegido
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/fluxo.js --modo=light|heavy --model=<gold model> --rotulo=<prefixo>
 *       [--finder=rodar|<pool existente>] [--prs=<lista.json>] [--refazer]
 *
 * --finder=rodar           roda o finder do zero (pools/<rotulo>_<model>) e julga com o juiz Martian.
 * --finder=<pool>          reaproveita um finder ja rodado (e a matriz do juiz dele). Em light,
 *                          so as sugestoes do generalista seguem: as passadas do finder sao
 *                          independentes, entao o generalista de um heavy e o generalista de um light.
 * --prs                    lista de PRs (json); padrao: os 30 do light.
 * Cada etapa pula se a saida ja existe (retoma uma rodada interrompida); --refazer roda tudo de novo.
 * Saida: resultados/fluxo/<rotulo>_<model>.json (tokens, tempo e regua por etapa) e a tabela no terminal.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const MODO = arg('modo'), GOLD = arg('model'), ROTULO = arg('rotulo'), FINDER = arg('finder', 'rodar');
const MODELO = process.env.RECALL_MODEL;
const REFAZER = process.argv.includes('--refazer');
if (!['light', 'heavy'].includes(MODO) || !GOLD || !ROTULO || !MODELO) {
    console.error('RECALL_MODEL=<id> --modo=light|heavy --model=<gold model> --rotulo=<prefixo> [--finder=rodar|<pool>] [--prs=<lista.json>]');
    process.exit(2);
}
const AQUI = __dirname;
const INV = path.join(AQUI, '..', '..', 'investigation');
const PRS = arg('prs', path.join(INV, 'light-30.json'));
const CASOS = JSON.parse(fs.readFileSync(PRS, 'utf8'));
const POOL = FINDER === 'rodar' ? `${ROTULO}_${GOLD}` : FINDER;
const MATRIZ = path.join(INV, 'results', `matriz-pre-${POOL}.json`);
const TEC = MODO === 'light' ? 'G' : 'G,M3';
const DEDUP = `${ROTULO}-dedup`;
const env = {
    ...process.env,
    RECALL_CLAUDE_SDK_DIR: process.env.RECALL_CLAUDE_SDK_DIR || path.join(require('os').homedir(), '.cache', 'kodus-eval-claude-sdk'),
    // GPT sempre com esforco baixo no eval.
    ...(/gpt/i.test(MODELO) && !process.env.RECALL_REASONING_EFFORT ? { RECALL_REASONING_EFFORT: 'low' } : {}),
};
const existe = (p) => !REFAZER && fs.existsSync(p);
function roda(nome, cmd, args, extraEnv = {}) {
    console.log(`\n[fluxo] ${nome}: ${cmd} ${args.join(' ')}`);
    const t0 = Date.now();
    const r = spawnSync(cmd, args, { cwd: path.join(AQUI, '..', '..', '..'), env: { ...env, ...extraEnv }, stdio: 'inherit' });
    if (r.status !== 0) { console.error(`[fluxo] ${nome} falhou (exit ${r.status})`); process.exit(2); }
    return Date.now() - t0;
}
const rel = (p) => path.relative(path.join(AQUI, '..', '..', '..'), p);
const parede = {};

// 1. Finder (+ matriz do juiz Martian).
if (FINDER === 'rodar') {
    const dump = path.join(INV, 'pools', POOL);
    if (!(existe(dump) && fs.readdirSync(dump).filter((f) => f.endsWith('.raw.txt')).length >= CASOS.length)) {
        const lentes = MODO === 'heavy' ? {
            RECALL_MICRO_AGENTS: '1', RECALL_MICRO_EXP: 'p3', RECALL_MICRO_SO_EXTRAS: '1', RECALL_MICRO_TETO: '4',
            RECALL_MICRO_IDS: 'says-one-thing-does-another,text-that-ships,invalid-state-and-concurrency,value-boundary-and-position,secret-and-identity,contract-not-followed,test-does-not-verify,data-exposure,changed-files-disagree',
        } : {};
        parede.finder = roda('finder', 'node', [rel(path.join(INV, 'run-recall.js'))], {
            RECALL_SKIP_VERIFY: '1', RECALL_SKIP_DEDUP: '1', RECALL_SKIP_SYNTHESIS: '1', RECALL_REDUCER: '0', RECALL_HEAVY: '0', RECALL_NO_JUDGE: '1',
            RECALL_SET: 'light', RECALL_CASES: CASOS.join(','), RECALL_CATEGORIES: 'bug,security,performance', RECALL_REAL_REPO: '1', RECALL_GATE: '0',
            RECALL_FINDING_REASON: '0', RECALL_GRAFO_EXP: '1', RECALL_PARALELO: '1', RECALL_CONCURRENCY: '3', RECALL_DUMP: dump, ...lentes,
        });
    }
    if (!existe(MATRIZ)) roda('juiz Martian', 'node', [rel(path.join(INV, 'matriz-prefilter.js')), `--dump=${POOL}`]);
}
if (!fs.existsSync(MATRIZ)) { console.error(`[fluxo] sem matriz do juiz: ${MATRIZ}`); process.exit(2); }

// 2. Sugestoes do finder na tecnica do modo (ids S1..Sn).
const SUG = path.join(AQUI, `${ROTULO}_${GOLD}.json`);
if (!existe(SUG)) roda('sugestoes', 'node', [rel(path.join(AQUI, 'build.js')), `--prefixo=${ROTULO}`, `--prs=${PRS}`, `--pools=${GOLD}:${POOL}`, `--tec=${TEC}`]);
// 3. Dedup de producao.
const DED = path.join(AQUI, 'dedup-real', DEDUP, `${GOLD}.json`);
if (!existe(DED)) parede.dedup = roda('dedup', 'node', [rel(path.join(AQUI, 'pipeline-ate-dedup.js')), `--model=${GOLD}`, '--fonte=gold', `--prefixo=${ROTULO}`, `--versao=${DEDUP}`, `--prs=${PRS}`]);
const FIN = path.join(AQUI, `${ROTULO}_${GOLD}.final.json`);
if (!existe(FIN)) roda('grupos', 'node', [rel(path.join(AQUI, 'final-de-dedup.js')), `--model=${GOLD}`, `--prefixo=${ROTULO}`, `--dedup=${DEDUP}`]);
// 4. Verify C: passo 1 (h1, ate 10 passos) e passo 2 (c3).
const R = (v) => path.join(AQUI, 'verify', 'resultados', v, `${GOLD}.json`);
if (!existe(R(`aluc-${ROTULO}-h1t10`))) parede.verify1 = roda('verify C passo 1', 'node', [rel(path.join(AQUI, 'verify', 'alucinacao.js')), `--model=${GOLD}`, `--prefixo=${ROTULO}`, `--dedup=${DEDUP}`, `--versao=${ROTULO}-h1t10`, '--prompt=h1', '--teto=10']);
if (!existe(R(`aluc-${ROTULO}-h1t10f`))) parede.verify2 = roda('verify C passo 2', 'node', [rel(path.join(AQUI, 'verify', 'alucinacao-confirma.js')), `--model=${GOLD}`, `--prefixo=${ROTULO}`, `--sobre=${ROTULO}-h1t10`, `--versao=${ROTULO}-h1t10f`, '--prompt=c3']);
// 5. Nit protegido (v3d, so grupos de um membro que o verify C manteve).
if (!existe(R(`${ROTULO}-nit-v3d-so1`))) parede.nit = roda('nit protegido', 'node', [rel(path.join(AQUI, 'verify', 'nit.js')), `--model=${GOLD}`, `--prefixo=${ROTULO}`, `--dedup=${DEDUP}`, '--versao=v3d', '--so1=1', `--sobre=aluc-${ROTULO}-h1t10f`, `--saida=${ROTULO}-nit-v3d-so1`]);

// 6. Relatorio: tokens e tempo por etapa (media por PR) e a regua Martian.
const tec = (pb) => (pb === 'generalist-base' ? 'G' : String(pb || '').startsWith('micro-exp-p3-') ? 'M3' : null);
const etapas = {};
const acum = (nome, u) => {
    const e = etapas[nome] || (etapas[nome] = { prs: 0, chamadas: 0, input: 0, cacheRead: 0, output: 0, reasoning: 0, ms: 0 });
    if (!u) return;
    e.prs++;
    for (const k of ['chamadas', 'input', 'cacheRead', 'output', 'reasoning', 'ms']) e[k] += u[k] || 0;
};
for (const c of CASOS) {
    const t = JSON.parse(fs.readFileSync(path.join(INV, 'pools', POOL, `${c}.raw.txt`), 'utf8')).trace;
    // Tempo do finder: as passadas correm em paralelo, entao o tempo do PR e o da mais lenta da tecnica.
    const passes = (t.recallPasses || []).filter((p) => TEC.split(',').includes(tec(p.label)));
    for (const T of TEC.split(',')) {
        const ps = passes.filter((p) => tec(p.label) === T);
        acum(`finder ${T === 'G' ? 'generalista' : 'M3'}`, {
            chamadas: ps.reduce((a, p) => a + (p.steps || 0), 0), input: ps.reduce((a, p) => a + (p.inputTokens || 0), 0), cacheRead: ps.reduce((a, p) => a + (p.cacheReadTokens || 0), 0),
            output: ps.reduce((a, p) => a + (p.outputTokens || 0), 0), reasoning: ps.reduce((a, p) => a + (p.reasoningTokens || 0), 0), ms: Math.max(0, ...ps.map((p) => p.ms || 0)),
        });
    }
}
const ler = (p) => JSON.parse(fs.readFileSync(p, 'utf8')).prs;
for (const [cid, p] of Object.entries(ler(DED))) acum('dedup', p.uso);
for (const [cid, p] of Object.entries(ler(R(`aluc-${ROTULO}-h1t10`)))) acum('verify C passo 1', p.uso);
for (const [cid, p] of Object.entries(ler(R(`aluc-${ROTULO}-h1t10f`)))) acum('verify C passo 2', p.uso);
for (const [cid, p] of Object.entries(ler(R(`${ROTULO}-nit-v3d-so1`)))) acum('nit protegido', p.uso);
const regua = (fontes, nit) => {
    const a = ['python3', [rel(path.join(AQUI, 'placar-grupos.py')), GOLD, `--prefixo=${ROTULO}`, `--dedup=${DEDUP}`, `--matriz=${MATRIZ}`, ...fontes, ...(nit ? [`--nit=${nit}`] : [])]];
    const r = spawnSync(a[0], a[1], { cwd: path.join(AQUI, '..', '..', '..'), encoding: 'utf8' });
    const m = (r.stdout || '').match(/\| (\d+) \| (\d+)\/(\d+) \| fp (\d+) \| ([\d.]+)% \| ([\d.]+)% \| ([\d.]+)% \|/);
    return m ? { comentarios: +m[1], goldens: +m[2], total: +m[3], recall: +m[5], precisao: +m[6], f1: +m[7] } : { erro: (r.stderr || r.stdout).slice(-300) };
};
const martian = {
    dedup: regua([]),
    'verify C': regua([`aluc-${ROTULO}-h1t10f`]),
    'nit protegido': regua([`aluc-${ROTULO}-h1t10f`], `${ROTULO}-nit-v3d-so1`),
};
const media = (e) => Object.fromEntries(['chamadas', 'input', 'cacheRead', 'output', 'reasoning', 'ms'].map((k) => [k, e.prs ? Math.round(e[k] / e.prs) : 0]));
const out = { modo: MODO, model: GOLD, modelo: MODELO, rotulo: ROTULO, pool: POOL, prs: CASOS.length, porEtapaMediaPorPr: Object.fromEntries(Object.entries(etapas).map(([k, e]) => [k, { ...media(e), prsMedidos: e.prs }])), paredeMs: parede, martian };
const OUT = path.join(AQUI, 'resultados', 'fluxo', `${ROTULO}_${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`\n[fluxo] ${MODO} · ${MODELO} · ${CASOS.length} PRs · media por PR`);
// Output ja inclui o raciocinio (os provedores cobram os dois pelo mesmo preco); a coluna so mostra quanto dele e raciocinio.
console.log('| Etapa | Chamadas | Input sem cache | Cache read | Output | dos quais raciocinio | Tempo |');
console.log('|---|---|---|---|---|---|---|');
for (const [k, e] of Object.entries(out.porEtapaMediaPorPr)) console.log(`| ${k} | ${e.chamadas} | ${e.input - e.cacheRead} | ${e.cacheRead} | ${e.output} | ${e.reasoning} | ${(e.ms / 1000).toFixed(1)} s |`);
console.log('\n| Depois de | Comentarios | Goldens | Recall | Precisao | F1 |\n|---|---|---|---|---|---|');
for (const [k, m] of Object.entries(martian)) console.log(m.erro ? `| ${k} | erro: ${m.erro} |` : `| ${k} | ${m.comentarios} | ${m.goldens}/${m.total} | ${m.recall} | ${m.precisao} | ${m.f1} |`);
console.log(`\n-> ${rel(OUT)}`);
process.exit(0);
