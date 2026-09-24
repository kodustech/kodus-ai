#!/usr/bin/env bun
/**
 * Responde UMA pergunta: o <CallGraph> muda se o baseline for filtrado como
 * producao filtra (astGraph.repository.ts#exportSubgraphJsonString)?
 *
 * Roda sob BUN, nao node: o baseline do grafana tem 705MB e o limite de string
 * do node e 512MB. O `kodus-graph` ja roda sob bun pelo mesmo motivo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const execFileAsync = promisify(execFile);
const { subgrafoComoProducao } = require('./subgrafo-producao');
const { repoDirFor, prepareRepo } = require('./prepare-repo');

const BUN = process.env.BUN_BIN || path.join(os.homedir(), '.bun/bin/bun');
const CLI = process.env.KODUS_GRAPH_CLI ||
    path.join(__dirname, '../../../kodus-graph/dist/cli.js');
const CG = path.join(os.homedir(), 'projects/benchmark/.callgraph');
const BASE = path.join(CG, '_baselines');
const TMP = path.join(CG, '_comparacao');
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v || []);
const RESERVADOS = new Set(['_baselines', '_comparacao']);

function casos() {
    const src = fs.readFileSync(path.join(__dirname, 'recall-tests.js'), 'utf8');
    const b = src.match(/LIGHT_CASES\s*=\s*\[([\s\S]*?)\]/);
    return new Set([...b[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

(async () => {
    fs.mkdirSync(TMP, { recursive: true });
    const ids = casos();
    const alvos = [];
    for (const f of fs.readdirSync(path.join(__dirname, 'datasets'))) {
        if (!f.endsWith('.json')) continue;
        let v;
        try { v = JSON.parse(fs.readFileSync(path.join(__dirname, 'datasets', f), 'utf8'))[0].vars; } catch { continue; }
        if (v?.caseId && ids.has(v.caseId)) alvos.push(v);
    }

    const linhas = [];
    for (const v of alvos) {
        const dir = fs.readdirSync(CG).find((d) => !RESERVADOS.has(d) && (v.caseId.startsWith(d) || d === v.caseId));
        if (!dir) continue;
        const atual = path.join(CG, dir, 'context.xml');
        const diffPath = path.join(CG, dir, 'pr.diff');
        if (!fs.existsSync(atual) || !fs.existsSync(diffPath)) continue;

        const repoDir = repoDirFor(v.repositoryFullName);
        let baseSha = v.benchmarkBaseRef;
        if (!baseSha) {
            const { stdout } = await execFileAsync('git', ['-C', repoDir, 'rev-parse', `${v.benchmarkHeadRef}^`]);
            baseSha = stdout.trim();
        }
        const full = path.join(BASE, `${path.basename(repoDir)}-${baseSha.slice(0, 12)}.json`);
        if (!fs.existsSync(full)) { console.log(`  ${v.caseId.slice(0,44)}: sem baseline`); continue; }

        const arquivos = J(v.changedFilesFull).map((x) => x.filename);
        const filtrado = path.join(TMP, `${dir}.baseline.json`);
        if (!fs.existsSync(filtrado)) {
            const g = JSON.parse(fs.readFileSync(full, 'utf8'));
            const sub = subgrafoComoProducao(g, arquivos);
            fs.writeFileSync(filtrado, JSON.stringify(sub));
            console.log(`  [${dir.slice(0,40)}] baseline ${g.nodes.length.toLocaleString()} nos -> ${sub.nodes.length.toLocaleString()} (${(100*sub.nodes.length/Math.max(1,g.nodes.length)).toFixed(1)}%)`);
        }

        // MESMO --repo-dir que gerou o XML atual: o worktree no HEAD do PR.
        // Passar o clone bare aqui devolve zero funcao alterada, em silencio.
        const handle = await prepareRepo(v, v.caseId);
        const saida = path.join(TMP, `${dir}.context.xml`);
        try {
            await execFileAsync(BUN, [CLI, 'context', '--files', ...arquivos,
                '--repo-dir', handle.dir, '--graph', filtrado, '--diff', diffPath,
                '--format', 'xml', '--out', saida],
                { maxBuffer: 256 * 1024 * 1024, timeout: 900_000 });
        } catch (e) {
            console.log(`  ${v.caseId.slice(0, 44)}: context FALHOU ${String(e.message || e).slice(0, 100)}`);
            await handle.cleanup?.();
            continue;
        }
        await handle.cleanup?.();

        const a = fs.readFileSync(atual, 'utf8');
        const b = fs.existsSync(saida) ? fs.readFileSync(saida, 'utf8') : '';
        const fn = (s) => new Set([...s.matchAll(/<ChangedFunction\b[^>]*\sname="([^"]+)"/g)].map((m) => m[1]));
        const cl = (s) => new Set([...s.matchAll(/<Caller\b[^>]*\sname="([^"]+)"[^>]*\sfile="([^"]+)"/g)].map((m) => `${m[2]}::${m[1]}`));
        const dif = (x, y) => [...x].filter((i) => !y.has(i)).length;
        const L = {
            cid: v.caseId, igual: a === b, ca: a.length, cb: b.length,
            fa: fn(a).size, fb: fn(b).size, fPerde: dif(fn(a), fn(b)), fGanha: dif(fn(b), fn(a)),
            kPerde: dif(cl(a), cl(b)), kGanha: dif(cl(b), cl(a)),
        };
        linhas.push(L);
        console.log(`  ${v.caseId.slice(0, 44).padEnd(46)} ${L.igual ? 'IDENTICO' : 'DIFERE  '} ` +
            `chars ${String(L.ca).padStart(6)}->${String(L.cb).padStart(6)} · ` +
            `funcoes ${L.fa}->${L.fb} (-${L.fPerde}/+${L.fGanha}) · callers -${L.kPerde}/+${L.kGanha}`);
    }
    const dif = linhas.filter((l) => !l.igual);
    console.log(`\n${linhas.length} casos · ${linhas.length - dif.length} IDENTICOS · ${dif.length} diferentes`);
    if (dif.length) {
        console.log(`funcoes alteradas: -${dif.reduce((n,l)=>n+l.fPerde,0)} / +${dif.reduce((n,l)=>n+l.fGanha,0)}`);
        console.log(`callers:           -${dif.reduce((n,l)=>n+l.kPerde,0)} / +${dif.reduce((n,l)=>n+l.kGanha,0)}`);
        console.log(`chars: ${dif.reduce((n,l)=>n+l.ca,0).toLocaleString()} -> ${dif.reduce((n,l)=>n+l.cb,0).toLocaleString()}`);
    }
    fs.writeFileSync(path.join(__dirname, 'results', 'comparacao-baseline.json'), JSON.stringify(linhas, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
