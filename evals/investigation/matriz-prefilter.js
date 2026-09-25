#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Matriz candidato-PRE-REDUCER x golden v002, com a confianca do judge.
 *
 * Paga-se uma vez. Depois, qualquer proposta de filtro — substituir o reducer,
 * substituir o gate, os dois, cortar por orcamento, por agente, por severidade
 * — vira aritmetica sobre esta matriz, sem uma chamada a mais. Foi a falta
 * disso que fez a variante "sem dois agentes" pagar 850 chamadas de novo.
 */
const fs = require('fs');
const path = require('path');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');
const S = process.env.POOL_ROOT || path.join(__dirname, 'pools');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const DUMP = arg('dump');
const SO = (arg('only', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const PAR = Number(arg('par', '10'));
const OUT = arg('out', path.join(__dirname, 'results', `matriz-pre-${DUMP}.json`));

(async () => {
    const v2 = JSON.parse(fs.readFileSync(path.join(__dirname, '../benchmark-sets/v002/goldens.json'), 'utf8'));
    const porCaso = Object.fromEntries(v2.prs.map((p) => [p.caseId, p.comments || []]));
    const key = loadJudgeKey();
    const out = {};
    let chamadas = 0;

    for (const f of fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'))) {
        const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
        const cid = j.caseId;
        if (SO.length && !SO.includes(cid)) continue;
        const gs = porCaso[cid] || [];
        const cands = j.trace?.preFilterCandidates || [];
        // PR sem candidato ENTRA na matriz, com lista vazia. Pular aqui era a
        // origem das tabelas de 29 PRs: o PR sumia da matriz, sumia do
        // denominador, e o recall subia sozinho porque os goldens que ninguem
        // achou deixavam de ser contados.
        if (!gs.length) continue;
        if (!cands.length) {
            out[cid] = {
                goldens: gs.map((g) => ({ comment: String(g.comment).slice(0, 220), category: g.category, severity: g.severity })),
                candidatos: [],
                conf: gs.map(() => []),
            };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} 0 cand x ${gs.length} goldens (entra vazio)`);
            continue;
        }

        const textos = cands.map((c) =>
            [c.oneSentenceSummary, c.suggestionContent].filter(Boolean).join('\n').slice(0, 1800));
        const conf = [];
        for (let gi = 0; gi < gs.length; gi++) {
            const linha = [];
            for (let b = 0; b < textos.length; b += PAR) {
                const lote = await Promise.all(
                    textos.slice(b, b + PAR).map(async (t) => {
                        chamadas++;
                        try {
                            const v = await matchCommentDetailed(key, gs[gi].comment, t);
                            return v?.match ? (v.confidence ?? 0) : 0;
                        } catch { return 0; }
                    }),
                );
                linha.push(...lote);
            }
            conf.push(linha);
        }
        out[cid] = {
            goldens: gs.map((g) => ({ comment: String(g.comment).slice(0, 220), category: g.category, severity: g.severity })),
            candidatos: cands.map((c) => ({
                producedBy: c.producedBy,
                relevantFile: c.relevantFile,
                relevantLinesStart: c.relevantLinesStart,
                severity: c.severity,
                confidence: c.confidence,
                oneSentenceSummary: String(c.oneSentenceSummary || '').slice(0, 200),
            })),
            conf,
        };
        console.log(`  ${cid.slice(0, 46).padEnd(48)} ${cands.length} cand x ${gs.length} goldens`);
    }
    fs.writeFileSync(OUT, JSON.stringify(out));
    console.log(`\n${Object.keys(out).length} PRs · ${chamadas} chamadas de judge\n-> ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
