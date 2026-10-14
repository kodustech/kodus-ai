#!/usr/bin/env node
/**
 * #1821: grupos para o verify quando nao ha gold de duplicatas rotulado (ex.:
 * holdout). Grava <prefixo>_<model>.final.json a partir do dedup real
 * (dedup-real/<versao>/<model>.json), depois do guarda de producao: uma
 * duplicata so entra no grupo do keep se o par passa no guarda, como em
 * placar-dedup-real.py. O verify e o nit.js so leem o campo `grupo`.
 *
 *   node evals/dedup/gold-v2/final-de-dedup.js --model=<gold model> --prefixo=<rotulo> --dedup=<versao>
 */
const fs = require('fs');
const path = require('path');

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const GOLD = arg('model'), PREFIXO = arg('prefixo'), DEDUP = arg('dedup');
if (!GOLD || !PREFIXO || !DEDUP) { console.error('--model= --prefixo= --dedup='); process.exit(2); }
const honra = (p) => p.lex >= 0.3 || (p.cos || 0) >= 0.7 || ((p.cos || 0) >= 0.4 && p.tb === true);

const DEST = path.join(__dirname, `${PREFIXO}_${GOLD}.final.json`);
// Nunca sobre o gold rotulado do light.
if (fs.existsSync(DEST) && !JSON.parse(fs.readFileSync(DEST, 'utf8')).fonte?.startsWith('dedup-real/')) { console.error(`${DEST} e um gold rotulado; nao sobrescrevo`); process.exit(2); }
const sug = JSON.parse(fs.readFileSync(path.join(__dirname, `${PREFIXO}_${GOLD}.json`), 'utf8')).prs;
const real = JSON.parse(fs.readFileSync(path.join(__dirname, 'dedup-real', DEDUP, `${GOLD}.json`), 'utf8')).prs;
const prs = {};
let grupos = 0;
for (const [cid, p] of Object.entries(sug)) {
    const d = real[cid];
    if (!d || d.erro) { console.error(`${cid}: sem dedup`); continue; }
    const grupo = {};
    // keep invalido: a producao mantem as duplicatas como independentes.
    for (const g of (d.groups || []).filter((x) => x.keep)) {
        const ok = g.duplicates.filter((dup) => {
            const par = (d.pares || []).find((q) => q.dup === dup && q.keep === g.keep);
            return dup !== g.keep && (!par || honra(par));
        });
        if (!ok.length) continue;
        grupos++;
        for (const id of [g.keep, ...ok]) grupo[id] = g.keep;
    }
    prs[cid] = Object.fromEntries(p.suggestions.map((s) => [s.id, { ...s, ...(grupo[s.id] ? { grupo: grupo[s.id] } : {}) }]));
}
fs.writeFileSync(DEST, JSON.stringify({ model: GOLD, fonte: `dedup-real/${DEDUP}`, prs }, null, 1));
console.log(`${GOLD}: ${Object.keys(prs).length} PRs, ${grupos} grupos com duplicatas`);
