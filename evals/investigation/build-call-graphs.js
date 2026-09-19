#!/usr/bin/env node
/**
 * Generate the AST call graph for each benchmark case and store it in the
 * dataset as `vars.callGraphJson`.
 *
 * Why this exists: the file-priority scorer derives a file's blast radius from
 * the call graph, but nothing ever produced the graph JSON — so every score fell
 * back to "biggest diff wins". This runs the SAME kodus-graph version production
 * pins (0.3.0) over the SAME input production parses (the changed files only),
 * so the eval scores files the way a fixed production would.
 *
 * Files come from the CLONE at the PR's head, not from the recorded readFile
 * replay. The replay only ever held what the six-file extractor asked for, so
 * a graph built from it covered at most six files — on the 127-file case it
 * covered one, and every file outside it scored structuralWeight 1.0, which
 * collapses the blast radius back into "biggest diff wins", the exact fallback
 * this script exists to remove. The replay stays as the fallback for a case
 * with no clone available.
 *
 * Usage:
 *   node evals/investigation/build-call-graphs.js [--case=<id>] [--dry-run]
 *   KODUS_GRAPH_CLI=/path/to/kodus-graph/dist/cli.js  (default: sibling checkout)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { repoDirFor } = require('./prepare-repo');

const DATASETS = path.join(__dirname, 'datasets');

/** Extensions kodus-graph has a parser for. A PR's full file list carries
 *  lockfiles, images, YAML and snapshots; handing those to `parse` costs time
 *  and contributes no node. */
const PARSEABLE = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.java', '.rb', '.cs', '.php', '.rs', '.kt', '.kts', '.scala',
]);
const BUN = process.env.BUN_BIN || path.join(os.homedir(), '.bun/bin/bun');
const CLI =
    process.env.KODUS_GRAPH_CLI ||
    path.join(__dirname, '../../../kodus-graph/dist/cli.js');

const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--case=')) || '').split('=')[1];
const setName = (args.find((a) => a.startsWith('--set=')) || '').split('=')[1];
/** Only the cases of a named set (LIGHT_CASES etc). Without it the script
 *  touches all 53 datasets, and the ones with no `changedFilesFull` would be
 *  rewritten with the same graph they already had — noise in the diff. */
const setIds = setName
    ? new Set(
          [
              ...require('fs')
                  .readFileSync(path.join(__dirname, 'recall-tests.js'), 'utf8')
                  .match(
                      new RegExp(`${setName.toUpperCase()}_CASES\\s*=\\s*\\[([\\s\\S]*?)\\]`),
                  )[1]
                  .matchAll(/'([^']+)'/g),
          ].map((m) => m[1]),
      )
    : null;
const dryRun = args.includes('--dry-run');

const j = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** The post-image of each file, read at the PR's head so the parser sees the
 *  code the review sees. `git show` rather than the worktree: the clone is
 *  shared between cases and may sit on any commit. */
function materializeFromClone(files, repoDir, headSha, root) {
    let written = 0;
    for (const p of files) {
        let content;
        try {
            content = execFileSync('git', ['-C', repoDir, 'show', `${headSha}:${p}`], {
                maxBuffer: 64 * 1024 * 1024,
            });
        } catch {
            continue; // deleted at head, or a path git cannot resolve
        }
        const dest = path.join(root, p);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
        written++;
    }
    return written;
}

function materialize(files, replay, root) {
    let written = 0;
    for (const entry of replay.readFile || []) {
        const p = entry?.match?.path;
        // Range reads are partial views of a file the corpus also holds in
        // full; writing one would truncate the source the parser sees.
        if (!p || entry.match.startLine || !files.includes(p)) continue;
        const dest = path.join(root, p);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, String(entry.result || ''));
        written++;
    }
    return written;
}

function buildGraph(files, root, outPath) {
    execFileSync(
        BUN,
        [CLI, 'parse', '--files', ...files, '--repo-dir', root, '--out', outPath],
        { stdio: 'pipe', timeout: 600000 },
    );
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
}

/** Edges whose two endpoints live in DIFFERENT changed files — the only ones
 *  the blast-radius score actually reads. Reported so a case with a technically
 *  large graph but no cross-file coupling is visible as such. */
function crossFileEdges(graph) {
    const owner = new Map(
        (graph.nodes || []).map((n) => [n.qualified_name, n.file_path]),
    );
    let n = 0;
    for (const e of graph.edges || []) {
        const from = owner.get(e.source_qualified);
        const to = owner.get(e.target_qualified);
        if (from && to && from !== to) n++;
    }
    return n;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kodus-graph-'));
let updated = 0;
const rows = [];

for (const file of fs.readdirSync(DATASETS).sort()) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(DATASETS, file);
    const records = JSON.parse(fs.readFileSync(full, 'utf8'));
    let dirty = false;

    for (const record of records) {
        const vars = record.vars || {};
        if (!vars.caseId || (only && vars.caseId !== only)) continue;
        if (setIds && !setIds.has(vars.caseId)) continue;
        const fullFiles = j(vars.changedFilesFull) || [];
        const files = (
            fullFiles.length
                ? fullFiles.map((f) => f?.filename).filter(Boolean)
                : j(vars.extractedFilePaths) || []
        ).filter((p) => PARSEABLE.has(path.extname(p).toLowerCase()));
        const replay = j(vars.toolReplay) || {};
        if (!files.length) {
            rows.push([vars.caseId, 'SKIP (nenhum arquivo parseável)']);
            continue;
        }

        const root = path.join(tmpRoot, vars.caseId);
        const repoDir = repoDirFor(vars.repositoryFullName);
        const headSha = vars.benchmarkHeadRef;
        let written = 0;
        let source = 'clone';
        if (repoDir && headSha && fs.existsSync(repoDir)) {
            written = materializeFromClone(files, repoDir, headSha, root);
        }
        // No clone, or a head the clone does not have: fall back to the replay,
        // which can only cover the files the old extractor recorded.
        if (!written) {
            source = 'replay';
            written = materialize(files, replay, root);
        }
        if (!written) {
            rows.push([vars.caseId, `SKIP (0/${files.length} arquivos materializados)`]);
            continue;
        }
        // Parse only what is actually on disk — a file deleted at head has no
        // post-image and `parse` errors out on the missing path.
        const present = files.filter((p) => fs.existsSync(path.join(root, p)));

        let graph;
        try {
            graph = buildGraph(present, root, path.join(tmpRoot, `${vars.caseId}.json`));
        } catch (err) {
            rows.push([vars.caseId, `FALHOU: ${String(err.message).slice(0, 80)}`]);
            continue;
        }

        const cross = crossFileEdges(graph);
        rows.push([
            vars.caseId,
            `${present.length}/${files.length} arq (${source}) · ${graph.nodes?.length ?? 0} nós · ${graph.edges?.length ?? 0} arestas · ${cross} entre arquivos`,
        ]);

        vars.callGraphJson = JSON.stringify({
            nodes: graph.nodes || [],
            edges: graph.edges || [],
        });
        dirty = true;
        updated++;
    }

    if (dirty && !dryRun) {
        fs.writeFileSync(full, `${JSON.stringify(records, null, 2)}\n`);
    }
}

for (const [id, info] of rows) console.log(`${id.slice(0, 48).padEnd(48)} ${info}`);
console.log(`\n${updated} casos com grafo${dryRun ? ' (dry-run, nada gravado)' : ' gravado'}`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
