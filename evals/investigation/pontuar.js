/**
 * Pontua qualquer subconjunto do pool ds16b sem chamar o judge.
 *
 * A matriz candidato x golden ja esta em disco (`teto-ds16b-matriz.json`), e o
 * conjunto que o reducer manteve sao candidatos verbatim do pool — conferido:
 * 154 de 154 casam. Entao um filtro que rode depois dele so escolhe indices, e
 * recall/precision saem de aritmetica. A regra aqui e a de `recall-assertion`:
 * por golden vence a maior confianca, candidato que nunca vence e falso
 * positivo. Validado contra o proprio run: 154 mantidos -> tp 57, fp 97, os
 * mesmos numeros que o pipeline reportou.
 */
const fs = require('fs');
const path = require('path');
const M = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'teto-ds16b-matriz.json'), 'utf8'));

function metrica(mant) {
    let TP = 0, FP = 0, GOLD = 0, KEPT = 0;
    for (const [cid, d] of Object.entries(M)) {
        const conf = d.conf, ng = d.goldens.length, nc = d.candidatos.length;
        GOLD += ng;
        const keep = mant[cid] ? new Set(mant[cid]) : new Set([...Array(nc).keys()]);
        KEPT += keep.size;
        const venceu = new Array(nc).fill(false), casou = new Array(ng).fill(false);
        for (let gi = 0; gi < ng; gi++) {
            let best = 0;
            for (const fi of [...keep].sort((a, b) => a - b)) {
                if (conf[gi][fi] > best) { best = conf[gi][fi]; casou[gi] = true; venceu[fi] = true; }
            }
        }
        TP += casou.filter(Boolean).length;
        FP += [...keep].filter((fi) => !venceu[fi]).length;
    }
    const r = TP / GOLD, p = TP + FP ? TP / (TP + FP) : 0;
    return { KEPT, TP, FP, GOLD, recall: r, precision: p, f1: r + p ? (2 * r * p) / (r + p) : 0 };
}

const linha = (nome, m) =>
    `  ${nome.padEnd(26)} ${String(m.KEPT).padStart(6)} ${String(m.TP).padStart(4)} ${String(m.FP).padStart(4)}  ${(100 * m.recall).toFixed(1).padStart(6)}% ${(100 * m.precision).toFixed(1).padStart(8)}% ${m.f1.toFixed(3).padStart(7)}`;

module.exports = { metrica, linha };

if (require.main === module) {
    const arquivos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
    console.log(`  ${''.padEnd(26)} ${'mantid'.padStart(6)} ${'tp'.padStart(4)} ${'fp'.padStart(4)}  ${'recall'.padStart(7)} ${'precision'.padStart(9)} ${'F1'.padStart(7)}`);
    console.log(linha('pool sem filtro', metrica({})));
    const red = JSON.parse(fs.readFileSync(path.join(__dirname, 'results', 'reducer-keep-idx.json'), 'utf8'));
    console.log(linha('reducer (baseline)', metrica(red)));
    for (const f of arquivos) {
        const j = JSON.parse(fs.readFileSync(f, 'utf8'));
        console.log(linha(j.teste ? `reducer -> ${j.teste}` : path.basename(f), metrica(j.keep || j)));
    }
    const venc = {};
    for (const [cid, d] of Object.entries(M)) {
        const conf = d.conf, ng = d.goldens.length, nc = d.candidatos.length;
        const v = new Array(nc).fill(false);
        for (let gi = 0; gi < ng; gi++) {
            let best = 0;
            for (let fi = 0; fi < nc; fi++) if (conf[gi][fi] > best) { best = conf[gi][fi]; v[fi] = true; }
        }
        venc[cid] = [...Array(nc).keys()].filter((i) => v[i]);
    }
    console.log(linha('ORACULO', metrica(venc)));
}
