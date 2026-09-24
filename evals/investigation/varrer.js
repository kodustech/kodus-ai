/**
 * Varre o parametro de cada teste de precisao sobre a matriz, sem chamar nada.
 *
 * Os dois testes guardam a decisao em peças separaveis — `post`/`drop`
 * ponderados no vanilla, `concreto`/`refutado` no gate — em vez de so o
 * booleano final. Entao a regra de corte deixa de ser escolha feita as cegas
 * antes do run e vira leitura da curva depois dele.
 */
const fs = require('fs');
const path = require('path');
const { metrica, linha } = require('./pontuar');

const R = path.join(__dirname, 'results');
const red = JSON.parse(fs.readFileSync(path.join(R, 'reducer-keep-idx.json'), 'utf8'));
const cab = `  ${''.padEnd(26)} ${'mantid'.padStart(6)} ${'tp'.padStart(4)} ${'fp'.padStart(4)}  ${'recall'.padStart(7)} ${'precision'.padStart(9)} ${'F1'.padStart(7)}`;

const deDetalhe = (det, pred) => {
    const k = {};
    for (const [cid, idxs] of Object.entries(red)) k[cid] = new Set(idxs);
    for (const d of det) if (!pred(d)) k[d.caseId]?.delete(d.fi);
    return Object.fromEntries(Object.entries(k).map(([c, s]) => [c, [...s]]));
};

console.log(cab);
console.log(linha('reducer (baseline)', metrica(red)));

const vanArq = fs.existsSync(path.join(R, 'pt-vanilla2.json'))
    ? path.join(R, 'pt-vanilla2.json')
    : path.join(R, 'pt-vanilla.json');
if (fs.existsSync(vanArq)) {
    const det = JSON.parse(fs.readFileSync(vanArq, 'utf8')).detalhe || [];
    console.log('\n  B — vanilla + self-consistency (corte = fracao do voto ponderado que pediu post)');
    for (const t of [0.0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
        const m = metrica(deDetalhe(det, (d) => {
            const tot = (d.post || 0) + (d.drop || 0);
            return tot ? d.post / tot >= t : true;
        }));
        console.log(linha(`  post-share >= ${t.toFixed(2)}`, m));
    }
}

for (const [rotulo, arq] of [['A  gate', 'pt-gate.json'], ['C  gate2 (duas provas)', 'pt-gate2.json']]) {
    const gateArq = path.join(R, arq);
    if (!fs.existsSync(gateArq)) continue;
    const det = JSON.parse(fs.readFileSync(gateArq, 'utf8')).detalhe || [];
    console.log(`\n  ${rotulo}`);
    console.log(linha('  so exige prova', metrica(deDetalhe(det, (d) => d.concreto))));
    console.log(linha('  so exige nao-refutado', metrica(deDetalhe(det, (d) => !d.refutado))));
    console.log(linha('  exige os dois', metrica(deDetalhe(det, (d) => d.concreto && !d.refutado))));
    if (det.some((d) => d.tipo)) {
        const n = (t) => det.filter((d) => d.tipo === t).length;
        console.log(`     provas: falha ${n('falha')} · contradicao ${n('contradicao')} · nenhuma ${n('nenhuma')}`);
    }
}

// Os dois juntos: o gate decide, o voto desempata.
if (fs.existsSync(vanArq) && fs.existsSync(path.join(R, 'pt-gate.json'))) {
    const dv = JSON.parse(fs.readFileSync(vanArq, 'utf8')).detalhe || [];
    const gAlvo = fs.existsSync(path.join(R, 'pt-gate2.json')) ? path.join(R, 'pt-gate2.json') : path.join(R, 'pt-gate.json');
    const dg = JSON.parse(fs.readFileSync(gAlvo, 'utf8')).detalhe || [];
    const share = {};
    for (const d of dv) {
        const tot = (d.post || 0) + (d.drop || 0);
        share[`${d.caseId}::${d.fi}`] = tot ? d.post / tot : 1;
    }
    console.log('\n  A+B — portao do gate E voto acima do corte');
    for (const t of [0.4, 0.5, 0.6, 0.7, 0.8]) {
        const m = metrica(deDetalhe(dg, (d) => d.concreto && !d.refutado && (share[`${d.caseId}::${d.fi}`] ?? 1) >= t));
        console.log(linha(`  gate + share >= ${t.toFixed(2)}`, m));
    }
}
