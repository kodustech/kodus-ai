#!/usr/bin/env node
/**
 * Junta casos de duas ou mais rodadas num artefato so, recalculando as
 * metricas agregadas.
 *
 * Para que serve: uma regra que so age acima de um limiar e no-op para todo PR
 * abaixo dele, entao os casos pequenos sao a MESMA configuracao nas duas
 * rodadas. Se a rodada com a regra sair pior, da para isolar o efeito rodando
 * so os casos afetados no modo default e reaproveitando os demais, em vez de
 * pagar 30 PRs de novo.
 *
 * O que este script NAO faz, de proposito: fingir que o resultado e uma rodada
 * unica. Cada linha carrega de qual arquivo veio, e o resumo traz a lista por
 * origem. Misturar tiragens diferentes e legitimo quando a configuracao e a
 * mesma; apresentar isso como uma execucao so e o tipo de erro que ja custou
 * dias aqui — duas rodadas da mesma config saem ~96% disjuntas nos achados, e
 * um agregado sem procedencia esconde exatamente isso.
 *
 * Precedencia: o primeiro arquivo que traz o caso vence. Entao liste primeiro
 * a rodada que deve prevalecer.
 *
 * Uso:
 *   node juntar-runs.js --out=results/misto.json \
 *     results/default-4-grandes.json results/com-corte-30.json
 */
const fs = require('fs');
const path = require('path');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const OUT = arg('out', path.join(__dirname, 'results', 'misto.json'));
const arquivos = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (arquivos.length < 2) {
    console.error('uso: node juntar-runs.js --out=<arquivo> <run1.json> <run2.json> [...]');
    process.exit(2);
}

const sum = (xs) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
const media = (xs) => (xs.length ? sum(xs) / xs.length : null);

const linhas = new Map();
const origem = {};
for (const f of arquivos) {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const nome = path.basename(f);
    origem[nome] = [];
    for (const r of j.rows || []) {
        if (linhas.has(r.caseId)) continue; // primeiro vence
        linhas.set(r.caseId, { ...r, __origem: nome });
        origem[nome].push(r.caseId);
    }
}

const rows = [...linhas.values()];
const comMeta = rows.filter((r) => r.metadata);
const tp = sum(comMeta.map((r) => r.metadata.tp));
const fp = sum(comMeta.map((r) => r.metadata.fp));
const fn = sum(comMeta.map((r) => r.metadata.fn));
const recall = tp + fn > 0 ? tp / (tp + fn) : null;
const precision = tp + fp > 0 ? tp / (tp + fp) : null;
const f1 = recall && precision ? (2 * recall * precision) / (recall + precision) : null;

const metrics = {
    recall_mean: media(comMeta.map((r) => r.metadata.recall).filter((x) => x != null)),
    precision_mean: media(comMeta.map((r) => r.metadata.precision).filter((x) => x != null)),
    f1_mean: media(comMeta.map((r) => r.metadata.f1).filter((x) => x != null)),
    tp, fp, fn,
    recall_pooled: recall,
    precision_pooled: precision,
    f1_pooled: f1,
};

fs.writeFileSync(
    OUT,
    JSON.stringify(
        {
            // Bandeira explicita: quem ler o arquivo depois precisa saber que
            // ele nao e uma execucao unica.
            misto: true,
            origens: origem,
            cases: rows.length,
            metrics,
            rows,
        },
        null,
        2,
    ),
);

console.log(`\n${rows.length} casos de ${arquivos.length} rodadas`);
for (const [nome, ids] of Object.entries(origem)) {
    console.log(`  ${ids.length.toString().padStart(3)} de ${nome}`);
}
console.log(`\ntp ${tp} · fp ${fp} · fn ${fn}`);
console.log(`recall ${(100 * recall).toFixed(1)}% · precision ${(100 * precision).toFixed(1)}% · F1 ${f1.toFixed(3)}`);
console.log(`-> ${OUT}`);
