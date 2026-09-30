#!/usr/bin/env node
/**
 * #1821 — o GPT no agente nativo dele. Roda `codex review --base` (o review do
 * Codex CLI, com o rubric oficial da OpenAI) em cada PR do benchmark, no
 * worktree do commit de head, e grava a saida bruta. O equivalente, para o GPT,
 * do teste do Claude Code headless: mede quanto o nosso loop custa ao modelo.
 *
 *   CODEX_HOME=<dir isolado, logado com chave de API> \
 *     node codex-review-bench.js --casos=a,b --out=<dir> [--par=3]
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { prepareRepo } = require('./prepare-repo');

const arg = (n, d) => {
    const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`));
    return h ? h.slice(n.length + 3) : d;
};
const OUT = arg('out');
const CASOS = arg('casos', '').split(',').filter(Boolean);
const PAR = Number(arg('par', '3'));
if (!OUT || !CASOS.length || !process.env.CODEX_HOME) {
    console.error('uso: CODEX_HOME=... node codex-review-bench.js --casos=... --out=...');
    process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const vars = {};
for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
    if (!f.endsWith('.json')) continue;
    try {
        const v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars;
        if (v?.caseId) vars[v.caseId] = v;
    } catch {}
}

const sh = (cmd, args, opts) =>
    new Promise((res) =>
        execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
            res({ code: err ? err.code ?? 1 : 0, stdout, stderr }),
        ),
    );

async function um(cid) {
    const v = vars[cid];
    if (!v) return console.log(`  ${cid}: sem dataset`);
    const repo = await prepareRepo(v, cid);
    if (!repo) return console.log(`  ${cid}: repo indisponivel`);
    const t0 = Date.now();
    let base = null;
    try {
        // Um nome por PR: PRs do mesmo repositorio rodam em paralelo e dividem
        // as refs do clone, entao um nome fixo colide ("cannot lock ref").
        base = `kodus-bench-base-${process.pid}-${cid.slice(0, 40)}`;
        // Caso de commit unico (sem PR) nao traz base no dataset: o pai do
        // commit de head e a base.
        let baseRef = v.benchmarkBaseRef;
        if (!baseRef) {
            const pai = await sh('git', ['-C', repo.dir, 'rev-parse', 'HEAD^']);
            baseRef = pai.stdout.trim();
        }
        const b = await sh('git', ['-C', repo.dir, 'branch', '-f', base, baseRef]);
        if (b.code) throw new Error(`base ${baseRef}: ${b.stderr.slice(0, 200)}`);
        const r = await sh('codex', ['review', '--base', base], {
            cwd: repo.dir,
            env: { ...process.env },
            timeout: 30 * 60 * 1000,
        });
        fs.writeFileSync(
            path.join(OUT, `${cid}.json`),
            JSON.stringify({ caseId: cid, code: r.code, ms: Date.now() - t0, stdout: r.stdout, stderr: r.stderr.slice(-20000) }, null, 1),
        );
        console.log(`  ${cid.slice(0, 50).padEnd(52)} exit ${r.code} · ${Math.round((Date.now() - t0) / 1000)}s · ${r.stdout.length} chars`);
    } catch (e) {
        console.log(`  ${cid}: FALHOU ${String(e.message).slice(0, 200)}`);
    } finally {
        if (base) await sh('git', ['-C', repo.dir, 'branch', '-D', base]);
        await repo.cleanup();
    }
}

(async () => {
    for (let i = 0; i < CASOS.length; i += PAR) await Promise.all(CASOS.slice(i, i + PAR).map(um));
})();
