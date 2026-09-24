#!/usr/bin/env bun
/**
 * Aplica ao baseline o MESMO filtro que producao aplica
 * (astGraph.repository.ts#exportSubgraphJsonString) e grava o resultado.
 *
 * Roda sob bun, nao node: o baseline do grafana tem 705MB e o limite de string
 * do node e 512MB.
 *
 *   bun filtrar-baseline.js <baseline-completo> <saida> <arquivo-com-a-lista>
 */
const fs = require('fs');
const { subgrafoComoProducao } = require('./subgrafo-producao');

const [entrada, saida, listaPath] = process.argv.slice(2);
if (!entrada || !saida || !listaPath) {
    console.error('uso: bun filtrar-baseline.js <entrada> <saida> <lista>');
    process.exit(1);
}
const arquivos = JSON.parse(fs.readFileSync(listaPath, 'utf8'));
const g = JSON.parse(fs.readFileSync(entrada, 'utf8'));
const sub = subgrafoComoProducao(g, arquivos);
fs.writeFileSync(saida, JSON.stringify(sub));
console.log(
    `[baseline] ${(g.nodes || []).length.toLocaleString()} nos -> ${sub.nodes.length.toLocaleString()} ` +
    `(${(100 * sub.nodes.length / Math.max(1, (g.nodes || []).length)).toFixed(1)}%), ` +
    `${(g.edges || []).length.toLocaleString()} arestas -> ${sub.edges.length.toLocaleString()}`,
);
