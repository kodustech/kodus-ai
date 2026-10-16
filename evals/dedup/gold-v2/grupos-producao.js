/**
 * #1821: os grupos que seguem para o verify e o nit, como em producao: a saida do
 * dedup real (final-de-dedup.js grava `grupo` = id do keep). O comentario que
 * segue no fluxo e o keep do dedup; os demais membros saem. O gabarito de dedup
 * (grupos F1, F2...) mede o dedup e nunca entra no fluxo.
 */
const fs = require('fs');
const path = require('path');

function carregaFinal(prefixo, gold) {
    const f = JSON.parse(fs.readFileSync(path.join(__dirname, `${prefixo}_${gold}.final.json`), 'utf8'));
    if (!String(f.fonte || '').startsWith('dedup-real/')) throw new Error(`${prefixo}_${gold}.final.json nao vem do dedup real (fonte=${f.fonte}); rode final-de-dedup.js`);
    return f.prs;
}

function grupos(sugs, final, entrada) {
    const chegou = new Set(entrada);
    const porKeep = {};
    const out = [];
    for (const s of sugs) {
        if (!chegou.has(s.id)) continue;
        const k = final[s.id]?.grupo;
        if (k) (porKeep[k] = porKeep[k] || []).push(s); else out.push([s]);
    }
    for (const [k, m] of Object.entries(porKeep)) {
        const keep = m.find((x) => x.id === k);
        if (!keep) throw new Error(`grupo ${k} sem o keep entre os membros`);
        out.push([keep, ...m.filter((x) => x !== keep)]);
    }
    return out.map((m) => ({ rep: m[0].id, membros: m.map((x) => x.id), agentes: [...new Set(m.map((x) => x.producedBy))], s: m[0] }));
}

module.exports = { carregaFinal, grupos };
