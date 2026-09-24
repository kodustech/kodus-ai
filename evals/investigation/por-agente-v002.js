#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Rendimento de cada micro-agente no pool PRE-FILTRO, contra o golden v002.
 *
 * A pergunta que responde: um agente que produz cinco achados e nenhum golden
 * esta pagando o proprio custo? So da para responder antes do reducer, porque
 * depois dele a atribuicao ja sofreu merge e descarte.
 *
 * Regra do rotulo: um candidato "acerta" se casa com algum golden do PR acima
 * de 0,5 de confianca. E frouxa de proposito — aqui nao se mede precision do
 * pipeline, se mede se o agente chega perto de algo real. Para a metrica final
 * vale a disputa por confianca, que e outra conta.
 */
const fs = require('fs');
const path = require('path');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');
// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const DUMP = arg('dump');
const PAR = Number(arg('par', '10'));
const OUT = arg('out', path.join(__dirname, 'results', `por-agente-v002-${DUMP}.json`));

(async () => {
    const v2 = JSON.parse(fs.readFileSync(path.join(__dirname, '../benchmark-sets/v002/goldens.json'), 'utf8'));
    const porCaso = Object.fromEntries(v2.prs.map((p) => [p.caseId, p.comments || []]));
    const key = loadJudgeKey();

    const ag = {};
    const registra = (nome, campo) => {
        ag[nome] ||= { total: 0, acertos: 0, porCategoria: {} };
        ag[nome][campo]++;
    };

    for (const f of fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'))) {
        const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
        const gs = porCaso[j.caseId] || [];
        const cands = j.trace?.preFilterCandidates || [];
        if (!gs.length || !cands.length) continue;

        for (let b = 0; b < cands.length; b += PAR) {
            await Promise.all(
                cands.slice(b, b + PAR).map(async (c) => {
                    const nome = c.producedBy || '?';
                    const txt = [c.oneSentenceSummary, c.suggestionContent].filter(Boolean).join('\n').slice(0, 1800);
                    let casouCom = null;
                    for (const g of gs) {
                        try {
                            const v = await matchCommentDetailed(key, g.comment, txt);
                            if (v?.match && (v.confidence ?? 0) >= 0.5) { casouCom = g; break; }
                        } catch {}
                    }
                    registra(nome, 'total');
                    if (casouCom) {
                        registra(nome, 'acertos');
                        const cat = casouCom.category || '(sem)';
                        ag[nome].porCategoria[cat] = (ag[nome].porCategoria[cat] || 0) + 1;
                    }
                }),
            );
        }
        console.log(`  ${j.caseId.slice(0, 46)}`);
    }

    const linhas = Object.entries(ag)
        .map(([nome, v]) => ({ nome, ...v, fp: v.total - v.acertos, taxa: v.total ? v.acertos / v.total : 0 }))
        .sort((a, b) => a.taxa - b.taxa || b.total - a.total);

    fs.writeFileSync(OUT, JSON.stringify({ dump: DUMP, goldenSet: 'v002', agentes: linhas }, null, 2));
    const T = linhas.reduce((s, x) => s + x.total, 0);
    const A = linhas.reduce((s, x) => s + x.acertos, 0);
    console.log(`\n${T} candidatos · ${A} casam com golden (${((100 * A) / T).toFixed(0)}%)\n`);
    console.log(`${'micro-agente'.padEnd(38)} ${'gerou'.padStart(6)} ${'acertos'.padStart(8)} ${'FP'.padStart(5)} ${'taxa'.padStart(6)}`);
    for (const x of linhas) {
        console.log(`${x.nome.padEnd(38)} ${String(x.total).padStart(6)} ${String(x.acertos).padStart(8)} ${String(x.fp).padStart(5)} ${(100 * x.taxa).toFixed(0).padStart(5)}%`);
    }
    console.log(`\n-> ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
