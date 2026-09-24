/**
 * O que o filtro matou, e se matou certo.
 *
 * Recall e precision dizem que um filtro piorou, nao ONDE. Aqui cada refutado
 * e cruzado com o rotulo do pool pre-reducer: se o candidato casava com um
 * golden, o descarte foi um erro caro e a evidencia do veredito sai junto para
 * dar para ler por que ele se convenceu.
 */
const fs = require('fs');
const path = require('path');
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const IN = arg('in', path.join(__dirname, 'results', 'f-walk.json'));
const LABELS = arg('labels', path.join(__dirname, 'results', 'labels-ds16b.json'));
// Onde ficam os dumps. Ja foi um caminho absoluto de scratchpad cravado aqui,
// o que fazia o script falhar em silencio fora daquela sessao.
const S = process.env.POOL_ROOT || require('path').join(__dirname, 'pools');
const DUMP = arg('dump', 'ds16b');

const labels = JSON.parse(fs.readFileSync(LABELS, 'utf8'));
const res = JSON.parse(fs.readFileSync(IN, 'utf8'));

// O rotulo e por indice na ordem de preFilterCandidates; o descartado so tem o
// conteudo. Reconstroi a chave a partir do dump para casar os dois.
const chave = (c) => `${c.relevantFile}|${c.relevantLinesStart}|${String(c.oneSentenceSummary || '').slice(0, 80)}`;
const rotuloPorChave = {};
for (const f of fs.readdirSync(path.join(S, DUMP)).filter((x) => x.endsWith('.raw.txt'))) {
    const j = JSON.parse(fs.readFileSync(path.join(S, DUMP, f), 'utf8'));
    const h = labels[j.caseId] || [];
    (j.trace?.preFilterCandidates || []).forEach((c, i) => {
        rotuloPorChave[`${j.caseId}::${chave(c)}`] = !!h[i];
    });
}

let bons = 0, ruins = 0, semRotulo = 0;
const erros = [];
for (const pr of res.porPR || []) {
    for (const d of pr.descartados || []) {
        const k = `${pr.caseId}::${chave(d)}`;
        if (!(k in rotuloPorChave)) { semRotulo++; continue; }
        if (rotuloPorChave[k]) { ruins++; erros.push({ caseId: pr.caseId, ...d }); }
        else bons++;
    }
}
const tot = bons + ruins;
console.log(`\nDESCARTES DE ${path.basename(IN)}`);
console.log(`  ${tot} refutados com rotulo (${semRotulo} sem)`);
console.log(`  ${bons} eram falso positivo — descarte correto (${tot ? ((100 * bons) / tot).toFixed(0) : 0}%)`);
console.log(`  ${ruins} casavam com golden — descarte CARO (${tot ? ((100 * ruins) / tot).toFixed(0) : 0}%)`);

if (erros.length) {
    console.log(`\nOS QUE ELE NAO DEVERIA TER MATADO\n`);
    for (const e of erros) {
        console.log('='.repeat(92));
        console.log(`${e.caseId}`);
        console.log(`${e.relevantFile}:${e.relevantLinesStart}-${e.relevantLinesEnd}  [${e.producedBy || '?'}]`);
        console.log(`RESUMO : ${String(e.oneSentenceSummary || '').slice(0, 180)}`);
        console.log(`WALK   : ${String(e.reason || '(sem)').slice(0, 400)}`);
        console.log(`MOTIVO : ${String(e.evidencia || '').slice(-700)}`);
    }
}
