#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env.local'), override: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Funde os grupos do atribuidor por arquivo, COMPOE o texto do comentario
 * fundido (todos os membros, nao so o representante) e julga o texto composto
 * contra os goldens.
 *
 * Isto e o que separa a medida otimista da pessimista: fundir so ajuda se o
 * comentario resultante ainda casar com todos os goldens que os membros
 * casavam separados. Aqui isso deixa de ser suposicao.
 */
const fs = require('fs');
const path = require('path');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');
// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const DUMP = arg('dump', 'sol-teto2');
const SEL = arg('sel', path.join(__dirname, 'results', 'seletor-vA-teto2-filtrado.json'));
const MAXM = Number(arg('maxmembros', '99'));
const PAR = Number(arg('par', '10'));
const OUT = arg('out', path.join(__dirname, 'results', `fundido-${DUMP}.json`));
const SEV = new Set(['low', 'medium', 'high', 'critical']);

(async () => {
    const v2 = JSON.parse(fs.readFileSync(path.join(__dirname, '../benchmark-sets/v002/goldens.json'), 'utf8'));
    const porCaso = Object.fromEntries(v2.prs.map((p) => [p.caseId, p.comments || []]));
    const sel = JSON.parse(fs.readFileSync(SEL, 'utf8')).saida;
    const key = loadJudgeKey();
    const out = {};
    let chamadas = 0;

    for (const f of fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'))) {
        const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
        const cid = j.caseId;
        const gs = porCaso[cid] || [];
        const cru = j.trace?.preFilterCandidates || [];
        if (!gs.length || !sel[cid]) continue;
        // mesmo filtro de contrato que o seletor usou
        const cands = cru.filter((c) => SEV.has(String(c?.severity || '').toLowerCase()) && !!c?.reason);
        if (cands.length !== sel[cid].candidatos) { console.log(`  ! ${cid} desalinhado`); continue; }

        // agrupa os grupos do atribuidor por arquivo
        const baldes = new Map();
        for (const g of sel[cid].grupos) {
            const ms = g.indices.map((i) => cands[i]).filter(Boolean);
            if (!ms.length) continue;
            const k = ms[0].relevantFile || '(sem arquivo)';
            if (!baldes.has(k)) baldes.set(k, []);
            baldes.get(k).push({ g, ms });
        }
        const fundidos = [];
        for (const [arquivo, lista] of baldes) {
            // se o balde for grande demais, quebra em pedacos de MAXM
            lista.sort((a, b) => (b.g.nota || 0) - (a.g.nota || 0));
            for (let i = 0; i < lista.length; i += MAXM) {
                const pedaco = lista.slice(i, i + MAXM);
                const membros = pedaco.flatMap((p) => p.ms);
                const texto = membros
                    .map((m) => [m.oneSentenceSummary, m.suggestionContent].filter(Boolean).join('\n'))
                    .join('\n\n---\n\n')
                    .slice(0, 6000);
                fundidos.push({
                    arquivo,
                    nota: Math.max(...pedaco.map((p) => p.g.nota || 0)),
                    reps: pedaco.map((p) => p.g.representante),
                    nMembros: membros.length,
                    nGrupos: pedaco.length,
                    severidade: membros.map((m) => m.severity),
                    confianca: membros.map((m) => m.confidence),
                    agentes: [...new Set(membros.map((m) => m.producedBy))],
                    texto,
                });
            }
        }
        // julga cada fundido contra cada golden
        const conf = [];
        for (let gi = 0; gi < gs.length; gi++) {
            const linha = [];
            for (let b = 0; b < fundidos.length; b += PAR) {
                const lote = await Promise.all(fundidos.slice(b, b + PAR).map(async (fd) => {
                    chamadas++;
                    try {
                        const v = await matchCommentDetailed(key, gs[gi].comment, fd.texto);
                        return v?.match ? (v.confidence ?? 0) : 0;
                    } catch { return 0; }
                }));
                linha.push(...lote);
            }
            conf.push(linha);
        }
        out[cid] = {
            goldens: gs.map((g) => ({ comment: String(g.comment).slice(0, 220), category: g.category, severity: g.severity })),
            fundidos: fundidos.map(({ texto, ...r }) => r),
            conf,
        };
        console.log(`  ${cid.slice(0, 46).padEnd(46)} ${sel[cid].grupos.length} grupos -> ${fundidos.length} fundidos`);
    }
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(`\nCOMPLETO ${Object.keys(out).length} PRs, ${chamadas} chamadas de judge`);
    console.log(`-> ${OUT}`);
})();
