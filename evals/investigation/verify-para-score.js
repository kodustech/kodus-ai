#!/usr/bin/env node
/**
 * Converte a saida do verify (por GRUPO) na tabela por CANDIDATO que
 * `ajustar-formula.py` consome em `--extra=<nome>` / `REP_EXTRA`.
 *
 * As duas pontas indexam coisas diferentes: o verify guarda `representante`
 * (posicao no pool JA filtrado) e `origem` (indice no pool inteiro); a formula
 * procura pelo indice ORIGINAL. Usar o errado desalinha em silencio — nao da
 * erro, so devolve 50 para tudo e o sinal some.
 *
 *   node verify-para-score.js --verify=results/x.json --out=results/score2verify-x.json
 */
const fs = require('fs');
const path = require('path');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const IN = path.resolve(arg('verify'));
const OUT = path.resolve(arg('out'));
const j = JSON.parse(fs.readFileSync(IN, 'utf8'));
const saida = {};
let comNota = 0, semNota = 0;
for (const [cid, v] of Object.entries(j.saida || {})) {
    const t = {};
    for (const g of v.grupos || []) {
        const s = typeof g.score === 'number' ? g.score : null;
        if (s === null) { semNota++; continue; }
        t[g.origem] = s;
        comNota++;
    }
    saida[cid] = t;
}
fs.writeFileSync(OUT, JSON.stringify({ origem: IN, modelo: j.modelo, saida }, null, 2));
console.log(`${comNota} grupos com nota, ${semNota} sem (viram 50 na formula) -> ${OUT}`);
