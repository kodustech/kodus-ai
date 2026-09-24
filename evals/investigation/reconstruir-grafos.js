#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Reconstroi o <CallGraph> de cada caso e CONFERE que ele descreve o mesmo
 * conjunto de arquivos que o diff do dataset.
 *
 * Existe porque o cache de grafo nao tinha invalidacao: os XMLs gravados em
 * 17/09 descreviam a versao truncada em 6 arquivos dos PRs, e
 * materialize-full-diff.js so entrou em 19/09. O codigo ja lia
 * `changedFilesFull`; o cache anulava a correcao em silencio. Um teste caro
 * rodado sobre isso mede o grafo do PR errado.
 */
const fs = require('fs');
const path = require('path');
const { buildPrCallGraph } = require('./build-pr-callgraph');
const { prepareRepo } = require('./prepare-repo');

const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};

function casos(set) {
    const src = fs.readFileSync(path.join(__dirname, 'recall-tests.js'), 'utf8');
    const bloco = src.match(new RegExp(`${set.toUpperCase()}_CASES\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    return [...bloco[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

(async () => {
    const ids = new Set(casos(arg('set', 'light')));
    const alvos = [];
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        let v;
        try { v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars; } catch { continue; }
        if (v?.caseId && ids.has(v.caseId)) alvos.push(v);
    }
    console.log(`${alvos.length} de ${ids.size} casos encontrados nos datasets\n`);

    const ruins = [];
    for (const v of alvos) {
        const arquivos = J(v.changedFilesFull).map((x) => x.filename);
        let handle = null;
        try {
            handle = await prepareRepo(v, v.caseId);
        } catch (e) {
            ruins.push([v.caseId, `repo falhou: ${String(e.message || e).slice(0, 80)}`]);
            continue;
        }
        const cg = await buildPrCallGraph(v, handle?.dir, v.caseId, (m) => console.log(m));
        if (!cg?.xml) { ruins.push([v.caseId, 'grafo nao gerado']); continue; }

        // CONFERENCIA. Duas afirmacoes diferentes vivem no XML e so uma delas
        // tem de estar dentro do diff:
        //
        //   <ChangedFunction file="..."> — o que ESTE PR alterou. Tem de estar
        //       no diff, sempre. Um arquivo aqui que o diff nao tem significa
        //       que o grafo foi montado sobre outro recorte do PR, que e
        //       exatamente a falha que nos custou esta rodada.
        //   <Caller file="..."> — quem chama o que mudou. Mora onde quiser, e
        //       estar FORA do diff e o motivo de o grafo existir.
        const alteradas = new Set(
            [...cg.xml.matchAll(/<ChangedFunction\b[^>]*\sfile="([^"]+)"/g)].map((m) => m[1]),
        );
        const chamadores = new Set(
            [...cg.xml.matchAll(/<Caller\b[^>]*\sfile="([^"]+)"/g)].map((m) => m[1]),
        );
        const fora = [...alteradas].filter((c) => !arquivos.includes(c));
        const deFora = [...chamadores].filter((c) => !arquivos.includes(c)).length;
        console.log(
            `  ${v.caseId.slice(0, 46).padEnd(48)} ${String(cg.xml.length).padStart(7)} chars · ` +
            `diff ${String(arquivos.length).padStart(3)} arq · alteradas em ${String(alteradas.size).padStart(3)} · ` +
            `callers ${String(chamadores.size).padStart(3)} (${deFora} fora do diff)` +
            (fora.length ? `  <-- ${fora.length} ALTERADA FORA DO DIFF` : ''),
        );
        if (fora.length)
            ruins.push([
                v.caseId,
                `${fora.length} <ChangedFunction> em arquivo que nao esta no diff: ${fora.slice(0, 3).join(', ')}`,
            ]);
    }

    console.log();
    if (ruins.length) {
        console.log(`FALHOU em ${ruins.length} caso(s):`);
        for (const [c, m] of ruins) console.log(`  ${c}\n    ${m}`);
        process.exit(1);
    }
    console.log(`OK — ${alvos.length} grafos reconstruidos e conferidos contra o diff atual.`);
})().catch((e) => { console.error(e); process.exit(1); });
