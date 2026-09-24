#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Pontua um dump contra o golden set v002 (o da Martian atualizado), com os
 * perfis de categoria e as DUAS contabilidades.
 *
 * A diferenca entre as duas esta no achado que casa com um golden cuja
 * categoria esta FORA do perfil:
 *
 *   neutro    — a regra da Martian. O achado sai da conta: nao e tp nem fp.
 *               Existe para nao punir ferramenta que acha problema real porem
 *               menor. E a conta que aproxima a nota deles.
 *
 *   punitivo  — o achado vira fp. Para nos, comentario de style ou
 *               especulativo e ruido no PR do cliente, entao a conta que
 *               descreve o nosso dia a dia e esta.
 *
 * Em ambas, achado que nao casa com golden nenhum e fp — a categoria e
 * atributo do GOLDEN, nunca do achado, e so existe quando houve casamento.
 *
 * Nao sobrescreve nada: grava num arquivo novo.
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
const OUT = arg('out', path.join(__dirname, 'results', `v002-${DUMP}.json`));
const PAR = Number(arg('par', '8'));
// --excluir=a,b — simula desligar micro-agentes: os achados que eles
// produziram saem da saida antes de pontuar. Aproximacao: o reducer rodou com
// o pool inteiro, entao ele pode ter fundido um achado do agente excluido com
// outro; aqui so se remove o que sobrou atribuido a ele.
const EXCLUIR = new Set((arg('excluir','')||'').split(',').map((x)=>x.trim()).filter(Boolean));

const PERFIS = {
    strict: new Set(['bug', 'security', 'concurrency', 'data', 'api']),
    core: new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect']),
    all: new Set(['bug', 'security', 'concurrency', 'data', 'api', 'perf', 'test_gap', 'doc_defect', 'style', 'speculative']),
};

const fbeta = (p, r, b) =>
    p + r > 0 ? ((1 + b * b) * p * r) / (b * b * p + r) : 0;

(async () => {
    const v2 = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../benchmark-sets/v002/goldens.json'), 'utf8'),
    );
    const porCaso = Object.fromEntries(v2.prs.map((p) => [p.caseId, p.comments || []]));
    const key = loadJudgeKey();
    if (!key) throw new Error('sem chave de judge');

    // acc[perfil][variante] = {tp, fp, fn}
    const acc = {};
    for (const perfil of Object.keys(PERFIS))
        acc[perfil] = { neutro: { tp: 0, fp: 0, fn: 0 }, punitivo: { tp: 0, fp: 0, fn: 0 } };
    let totalAchados = 0, totalGoldens = 0, excluidosCasados = 0;
    const porPR = [];

    const arquivos = fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'));
    for (const f of arquivos) {
        const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
        const cid = j.caseId;
        const gs = porCaso[cid] || [];
        if (!gs.length) { console.log(`  ${cid.slice(0, 44)} SEM GOLDEN no v002`); continue; }
        const achados = (j.findings || []).filter(
            (x) => !EXCLUIR.has(String(x.producedBy || '')),
        );
        totalAchados += achados.length;
        totalGoldens += gs.length;

        const textos = achados.map((c) =>
            [c.oneSentenceSummary, c.suggestionContent].filter(Boolean).join('\n').slice(0, 1800));

        // Mesma regra da metrica: por golden vence a maior confianca.
        // `donoDoGolden[gi]` = indice do achado que venceu aquele golden.
        const donoDoGolden = new Array(gs.length).fill(-1);
        const venceuAlgum = new Array(achados.length).fill(false);
        for (let gi = 0; gi < gs.length; gi++) {
            const confs = [];
            for (let b = 0; b < textos.length; b += PAR) {
                const lote = await Promise.all(
                    textos.slice(b, b + PAR).map(async (t) => {
                        try {
                            const v = await matchCommentDetailed(key, gs[gi].comment, t);
                            return v?.match ? (v.confidence ?? 0) : 0;
                        } catch { return 0; }
                    }),
                );
                confs.push(...lote);
            }
            let best = 0;
            for (let fi = 0; fi < confs.length; fi++) {
                if (confs[fi] > best) { best = confs[fi]; donoDoGolden[gi] = fi; venceuAlgum[fi] = true; }
            }
        }

        // A MATRIZ vai para disco. Sem ela, cada "e se eu desligar o agente X"
        // paga ~850 chamadas de judge de novo, que foi o que aconteceu na
        // primeira variante. Com ela, qualquer recorte vira aritmetica.
        const linha = {
            caseId: cid,
            achados: achados.length,
            goldens: gs.length,
            perfis: {},
            matriz: {
                goldens: gs.map((g) => ({ comment: String(g.comment).slice(0, 200), category: g.category, severity: g.severity })),
                achados: achados.map((a) => ({
                    producedBy: a.producedBy,
                    relevantFile: a.relevantFile,
                    relevantLinesStart: a.relevantLinesStart,
                    oneSentenceSummary: String(a.oneSentenceSummary || '').slice(0, 160),
                })),
                donoDoGolden,
            },
        };
        for (const [perfil, cats] of Object.entries(PERFIS)) {
            let tp = 0, fn = 0, fpExcluido = 0;
            const achadoExcluido = new Set();
            for (let gi = 0; gi < gs.length; gi++) {
                const dentro = cats.has(gs[gi].category);
                const dono = donoDoGolden[gi];
                if (dentro) {
                    if (dono >= 0) tp++; else fn++;
                } else if (dono >= 0) {
                    // casou com golden de categoria fora do perfil
                    achadoExcluido.add(dono);
                }
            }
            fpExcluido = achadoExcluido.size;
            // achado que nao venceu golden nenhum: fp nas duas variantes
            const fpBase = venceuAlgum.filter((v) => !v).length;
            acc[perfil].neutro.tp += tp;
            acc[perfil].neutro.fp += fpBase;
            acc[perfil].neutro.fn += fn;
            acc[perfil].punitivo.tp += tp;
            acc[perfil].punitivo.fp += fpBase + fpExcluido;
            acc[perfil].punitivo.fn += fn;
            linha.perfis[perfil] = { tp, fn, fpBase, fpExcluido };
            if (perfil === 'core') excluidosCasados += fpExcluido;
        }
        porPR.push(linha);
        console.log(`  ${cid.slice(0, 44).padEnd(46)} ${achados.length} achados · ${gs.length} goldens · core tp ${linha.perfis.core.tp}`);
    }

    const resumo = {};
    for (const perfil of Object.keys(PERFIS)) {
        resumo[perfil] = {};
        for (const variante of ['neutro', 'punitivo']) {
            const { tp, fp, fn } = acc[perfil][variante];
            const r = tp + fn ? tp / (tp + fn) : 0;
            const p = tp + fp ? tp / (tp + fp) : 0;
            resumo[perfil][variante] = {
                tp, fp, fn, recall: r, precision: p,
                f1: fbeta(p, r, 1), f2: fbeta(p, r, 2),
            };
        }
    }

    fs.writeFileSync(OUT, JSON.stringify({ dump: DUMP, goldenSet: 'v002', totalAchados, totalGoldens, resumo, porPR }, null, 2));

    console.log(`\n${arquivos.length} PRs · ${totalAchados} achados · ${totalGoldens} goldens (v002)`);
    console.log(`\n${'perfil'.padEnd(8)} ${'conta'.padEnd(9)} ${'tp'.padStart(4)} ${'fp'.padStart(4)} ${'fn'.padStart(4)} ${'recall'.padStart(8)} ${'precision'.padStart(10)} ${'F1'.padStart(7)} ${'F2'.padStart(7)}`);
    for (const perfil of Object.keys(PERFIS)) {
        for (const variante of ['neutro', 'punitivo']) {
            const m = resumo[perfil][variante];
            console.log(
                `${perfil.padEnd(8)} ${variante.padEnd(9)} ${String(m.tp).padStart(4)} ${String(m.fp).padStart(4)} ${String(m.fn).padStart(4)} ` +
                `${(100 * m.recall).toFixed(1).padStart(7)}% ${(100 * m.precision).toFixed(1).padStart(9)}% ${m.f1.toFixed(3).padStart(7)} ${m.f2.toFixed(3).padStart(7)}`,
            );
        }
    }
    console.log(`\n-> ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
