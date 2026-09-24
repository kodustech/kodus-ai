/**
 * Quantos goldens o pool PRE-reducer cobre — o teto de recall de qualquer
 * filtro que rode depois dele.
 *
 * Sem isto nao da para saber de quem e o problema. Se o pool cobre 75 goldens e
 * o reducer entrega 54, ha 21 de margem e vale mexer no filtro. Se o pool cobre
 * 56, o filtro ja esta no limite e o que falta e geracao — mexer no reducer
 * seria trabalhar onde nao ha o que ganhar.
 *
 * Usa a MESMA regra da metrica (`recall-assertion.js`): por golden, vence o
 * candidato de maior confianca; candidato que nao vence nenhum e falso
 * positivo. O `label-candidates` usa regra mais frouxa de proposito (serve para
 * rotular candidato, nao para contar tp), entao os dois numeros nao batem e nao
 * deveriam.
 */
const fs = require('fs');
const path = require('path');
const { loadJudgeKey, matchCommentDetailed } = require('./recall-judge');
const { carregarPool } = require('./label-candidates');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const DUMPS = arg('dumps', 'ds16b').split(',');
const PAR = Number(arg('par', '6'));
const OUT = arg('out', path.join(__dirname, 'results', `teto-${DUMPS.join('+')}.json`));

(async () => {
    require('./eval-tracing').registerTracing('teto-do-pool');
    const { pool, goldens } = carregarPool(DUMPS);
    const key = loadJudgeKey();
    if (!key) throw new Error('sem chave de judge');

    let cobertos = 0, totalGoldens = 0, totalCands = 0, vencedores = 0;
    const porPR = [];
    // A matriz inteira vai para disco. Julgar custa ~900 chamadas; guardando as
    // confiancas, qualquer corte de qualquer filtro passa a ser aritmetica
    // offline em vez de mais uma rodada de judge.
    const matriz = {};
    const ids = Object.keys(pool).filter((c) => goldens[c]?.length);

    for (const cid of ids) {
        const cands = pool[cid];
        const gs = goldens[cid];
        const textos = cands.map((c) =>
            [c.oneSentenceSummary, c.suggestionContent].filter(Boolean).join('\n').slice(0, 1800),
        );
        const melhor = new Array(gs.length).fill(0);
        const conf2d = [];
        const venceu = new Array(cands.length).fill(false);
        const casou = new Array(gs.length).fill(false);

        for (let gi = 0; gi < gs.length; gi++) {
            // Confianca por candidato primeiro, depois a disputa — a disputa e
            // sequencial por definicao (depende do melhor corrente), mas as
            // chamadas de judge nao sao.
            const confs = [];
            for (let b = 0; b < cands.length; b += PAR) {
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
            conf2d.push(confs);
            for (let fi = 0; fi < cands.length; fi++) {
                if (confs[fi] > melhor[gi]) { melhor[gi] = confs[fi]; casou[gi] = true; venceu[fi] = true; }
            }
        }
        matriz[cid] = {
            goldens: gs.map((g) => String(g.comment).slice(0, 300)),
            candidatos: cands.map((c) => ({
                relevantFile: c.relevantFile,
                relevantLinesStart: c.relevantLinesStart,
                oneSentenceSummary: c.oneSentenceSummary,
                producedBy: c.producedBy,
            })),
            conf: conf2d,
        };
        const c = casou.filter(Boolean).length;
        const v = venceu.filter(Boolean).length;
        cobertos += c; totalGoldens += gs.length; totalCands += cands.length; vencedores += v;
        porPR.push({ caseId: cid, goldens: gs.length, cobertos: c, candidatos: cands.length, vencedores: v });
        console.log(`  ${cid.slice(0, 44).padEnd(46)} ${c}/${gs.length} goldens cobertos · ${v}/${cands.length} candidatos vencem`);
    }

    const tetoRecall = cobertos / totalGoldens;
    // Precision de um filtro perfeito: manteria so os vencedores.
    const tetoPrecision = vencedores ? cobertos / vencedores : 0;
    console.log(`\nTETO DO POOL PRE-REDUCER (${DUMPS.join('+')})`);
    console.log(`  goldens cobertos : ${cobertos}/${totalGoldens}  -> recall maximo ${(100 * tetoRecall).toFixed(1)}%`);
    console.log(`  candidatos       : ${totalCands}, dos quais ${vencedores} vencem algum golden`);
    console.log(`  filtro perfeito  : manteria ${vencedores} e daria precision ${(100 * tetoPrecision).toFixed(1)}%`);
    fs.writeFileSync(OUT, JSON.stringify({ cobertos, totalGoldens, totalCands, vencedores, tetoRecall, tetoPrecision, porPR }, null, 2));
    const mOut = OUT.replace(/\.json$/, '-matriz.json');
    fs.writeFileSync(mOut, JSON.stringify(matriz));
    console.log(`-> ${mOut}`);
    console.log(`-> ${OUT}`);
})().catch((e) => { console.error(e); process.exit(1); });
