#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * O planner de microagentes (runMicroPlanner) rodado OFFLINE sobre uma rodada
 * que ja executou todos os agentes: para cada PR, quais ele mandaria rodar.
 * Com isso, derivar-nivel.py --plano=<saida> mostra o que o planner teria
 * produzido sem pagar nenhuma geracao nova.
 *
 *   node planner-offline.js --dump=<rodada> --model=<modelo> [--par=5] [--out=...]
 *
 * Mesmo prompt do produto (buildMicroPlannerPrompt) e mesmo diff que os agentes
 * receberam (rawDiffPrompt com os tiers do dump). Chama o modelo DA RODADA: o
 * runMicroPlanner de producao usa LLM.run com o slot BYOK, que no eval nao
 * existe e cairia no modelo padrao, nao no modelo que se esta medindo.
 */
const fs = require('fs');
const path = require('path');
const { generateText } = require('ai');
const { buildModel } = require('./eval-model');
const { buildMicroPlannerPrompt, MICRO_AGENTS } = require('../../libs/code-review/infrastructure/agents/core/micro-agents.ts');
const { rawDiffPrompt } = require('../../libs/code-review/infrastructure/agents/core/core-agent-loop.adapter.ts');

const S = process.env.POOL_ROOT || path.join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const DUMP = arg('dump');
const MODELO = arg('model');
const PAR = Number(arg('par', '5'));
const OUT = arg('out', path.join(__dirname, 'results', `plano-${DUMP}.json`));
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);

function datasetDe(caseId) {
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        try {
            const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
            if (v?.caseId === caseId) return v;
        } catch { /* arquivo de outro formato */ }
    }
    return null;
}

function idsDaResposta(texto) {
    const m = String(texto).match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
        return (JSON.parse(m[0]).run || []).map((r) => String(r?.id || '').trim()).filter(Boolean);
    } catch { return null; }
}

(async () => {
    if (!DUMP || !MODELO) { console.error('uso: --dump=<rodada> --model=<modelo>'); process.exit(1); }
    const validos = new Set(MICRO_AGENTS.map((g) => g.id));
    const arquivos = fs.readdirSync(path.join(S, DUMP)).filter((f) => f.endsWith('.raw.txt'));
    const out = {};
    let falhas = 0;
    let erros = 0;
    for (let b = 0; b < arquivos.length; b += PAR) {
        await Promise.all(arquivos.slice(b, b + PAR).map(async (f) => {
            const d = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
            const v = datasetDe(d.caseId);
            const diff = rawDiffPrompt(J(v.changedFilesFull || v.changedFiles), new Map(Object.entries(d.trace.fileTiers || {})));
            const prompt = buildMicroPlannerPrompt(diff) +
                '\n\nRespond with JSON only: {"run":[{"id":"<specialist id>","why":"<one sentence>"}]}';
            let ids = null;
            let ultimoErro = null;
            for (let t = 0; t < 3 && !ids; t++) {
                try { ids = idsDaResposta((await generateText({ model: buildModel(MODELO), prompt })).text); } catch (e) { ultimoErro = e; }
            }
            // Erro de API NAO e escolha do planner. No produto ele cai em "todos";
            // aqui isso mascararia uma chave faltando como resultado (26/09).
            if (!ids && ultimoErro) {
                erros++;
                console.log(`  ERRO ${d.caseId}: ${String(ultimoErro.message || ultimoErro).slice(0, 160)}`);
            }
            // Mesma regra do produto: resposta vazia ou invalida = todos os agentes.
            const escolhidos = (ids || []).filter((id) => validos.has(id));
            if (!escolhidos.length) falhas++;
            out[d.caseId] = escolhidos.length ? escolhidos : [...validos];
            console.log(`  ${d.caseId.slice(0, 50).padEnd(52)} ${escolhidos.length || 'TODOS (fallback)'} de ${validos.size}`);
        }));
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
    const media = Object.values(out).reduce((a, x) => a + x.length, 0) / Object.keys(out).length;
    console.log(`\n${Object.keys(out).length} PRs · media ${media.toFixed(1)} agentes por PR · ${falhas} caíram no fallback · ${erros} com ERRO de chamada\n-> ${OUT}`);
    if (erros) { console.error('ABORTADO: houve erro de chamada; o plano nao mede o planner.'); process.exit(2); }
})().catch((e) => { console.error(e); process.exit(1); });
