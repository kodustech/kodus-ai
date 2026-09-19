// Produces the `<CallGraph>` blob (and its structured twin) for one benchmark
// case, from a real clone.
//
// Why this exists: `agent-provider.js` reads `caseData.callGraph`, but NO
// dataset ever defined that field — grep every `datasets/*.json` and the count
// is zero. So the call-graph section of the generalist prompt has rendered
// EMPTY in every run we have ever measured, on every model. Production injects
// it (agent-review.stage.ts -> prompt-builder.ts), gated on a >=64k context
// window, which is exactly the class of model this investigation targets. The
// benchmark was blind to the one input big models were supposed to get.
//
// It also unlocks replacing the LLM Plan step: `analysis.changed_functions[]`
// already carries the symbol, what changed about its contract, and the resolved
// call sites — the three things the Plan prompt asks a model to guess at, then
// grep to confirm.
//
// Mirrors GraphContextService.generateContext (the DB-baseline path), not
// generateContextLegacy: the legacy path parses only the changed files, so the
// caller list can never leave the diff — which is the entire point here. The
// Postgres baseline production uses becomes, offline, a `parse --all` of a
// worktree at the PR's base commit.
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { repoDirFor, BENCH_ROOT } = require('./prepare-repo');

const BUN = process.env.BUN_BIN || path.join(os.homedir(), '.bun/bin/bun');
const CLI =
    process.env.KODUS_GRAPH_CLI ||
    path.join(__dirname, '../../../kodus-graph/dist/cli.js');

const CACHE_ROOT = path.join(BENCH_ROOT, '.callgraph');
const BASELINE_ROOT = path.join(CACHE_ROOT, '_baselines');

/** Same list the production indexer passes (graph-indexer.service.ts). */
const DEFAULT_EXCLUDES = [
    '**/tests/**',
    '**/test/**',
    '**/__tests__/**',
    '**/test_*',
    '**/*.test.*',
    '**/*.spec.*',
    '**/fixtures/**',
    '**/static/**',
    '**/__mocks__/**',
    '**/.yarn/**',
    '**/node_modules/**',
    '**/vendor/**',
    '**/dist/**',
    '**/build/**',
    '**/*.min.js',
    '**/*.min.css',
    '**/*.bundle.js',
    '**/*.chunk.js',
];

const PARSE_ALL_TIMEOUT_MS = 900_000;
const CONTEXT_TIMEOUT_MS = 180_000;

function j(v) {
    return typeof v === 'string' ? JSON.parse(v) : v;
}

/**
 * `changedFilesFull` FIRST. `changedFiles` is the six-file cut the extractor
 * wrote, so building the graph from it meant the <CallGraph> in the prompt
 * described a different pull request than the <Diffs> right above it — on the
 * 127-file case it covered one file. Production parses the changed files of
 * the PR; here that is the full list.
 */
function changedPaths(vars) {
    const files = j(vars.changedFilesFull)?.length
        ? j(vars.changedFilesFull)
        : j(vars.changedFiles) || [];
    return files
        .map((f) => f?.filename || f?.previous_filename)
        .filter(Boolean);
}

async function git(repoDir, args, opts = {}) {
    return execFileAsync('git', ['-C', repoDir, ...args], {
        maxBuffer: 256 * 1024 * 1024,
        timeout: opts.timeout ?? 300_000,
        ...opts,
    });
}

async function cli(args, timeout) {
    return execFileAsync(BUN, [CLI, ...args], {
        maxBuffer: 256 * 1024 * 1024,
        timeout,
    });
}

/**
 * Repo-wide graph at `sha`, cached on disk. This is the expensive half —
 * ~30s for cal.com, and it is what supplies every node the PR does not touch.
 * Cached per (repo, sha) because benchmark cases from the same repo often share
 * a base commit.
 */
async function baselineGraph(repoDir, sha, log) {
    fs.mkdirSync(BASELINE_ROOT, { recursive: true });
    const out = path.join(
        BASELINE_ROOT,
        `${path.basename(repoDir)}-${sha.slice(0, 12)}.json`,
    );
    if (fs.existsSync(out) && fs.statSync(out).size > 1024) return out;

    const wt = path.join(BENCH_ROOT, '.worktrees', `base-${sha.slice(0, 12)}`);
    let added = false;
    try {
        if (!fs.existsSync(wt)) {
            await git(repoDir, ['worktree', 'add', '--detach', '--force', wt, sha]);
            added = true;
        }
        const excludes = DEFAULT_EXCLUDES.flatMap((p) => ['--exclude', p]);
        log?.(`[callgraph] parse --all at ${sha.slice(0, 8)}`);
        await cli(
            [
                'parse',
                '--all',
                '--repo-dir',
                wt,
                ...excludes,
                '--allow-partial',
                '--out',
                out,
            ],
            PARSE_ALL_TIMEOUT_MS,
        );
        return fs.existsSync(out) ? out : null;
    } catch (err) {
        log?.(`[callgraph] baseline failed: ${String(err).slice(0, 200)}`);
        return null;
    } finally {
        if (added) {
            try {
                await git(repoDir, ['worktree', 'remove', '--force', wt], {
                    timeout: 120_000,
                });
            } catch {
                try {
                    fs.rmSync(wt, { recursive: true, force: true });
                } catch {}
            }
        }
    }
}

/**
 * The unified diff the CLI wants. The dataset's own diff is a Kodus rendering
 * (`## file:` / `__new hunk__`) that `parseDiffHunks` cannot read, so we
 * regenerate it from the two commits. It is load-bearing, not decoration: the
 * hunk-overlap filter is what keeps the structural diff from firing on every
 * function in a file whose baseline drifted.
 */
async function writeDiff(repoDir, baseSha, headSha, files, dest) {
    const { stdout } = await git(repoDir, [
        'diff',
        baseSha,
        headSha,
        '--',
        ...files,
    ]);
    fs.writeFileSync(dest, stdout);
    return stdout.length > 0;
}

/**
 * @param vars        the benchmark case's `vars`
 * @param headDir     worktree already checked out at the PR head (from prepareRepo)
 * @param caseId
 * @returns {Promise<{xml:string, json:object|null}|null>}
 */
async function buildPrCallGraph(vars, headDir, caseId, log) {
    const repoDir = repoDirFor(vars.repositoryFullName);
    if (!repoDir || !fs.existsSync(repoDir)) return null;

    const files = changedPaths(vars);
    if (!files.length) return null;

    const cacheDir = path.join(CACHE_ROOT, String(caseId).slice(0, 80));
    const xmlPath = path.join(cacheDir, 'context.xml');
    const jsonPath = path.join(cacheDir, 'context.json');
    if (fs.existsSync(xmlPath)) {
        return {
            xml: fs.readFileSync(xmlPath, 'utf8'),
            json: fs.existsSync(jsonPath)
                ? JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
                : null,
        };
    }
    fs.mkdirSync(cacheDir, { recursive: true });

    let headSha;
    try {
        headSha = execFileSync('git', ['-C', headDir, 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
        }).trim();
    } catch {
        return null;
    }

    // All 6 discourse cases in the light set carry a null `benchmarkBaseRef`.
    // First parent is the right substitute: for a merge head it IS the base
    // branch tip, and for a squashed head it is the commit the PR branched from.
    let baseSha = vars.benchmarkBaseRef;
    if (!baseSha) {
        try {
            baseSha = execFileSync(
                'git',
                ['-C', headDir, 'rev-parse', `${headSha}^`],
                { encoding: 'utf8' },
            ).trim();
        } catch {
            return null;
        }
    }

    const graphPath = await baselineGraph(repoDir, baseSha, log);
    // No baseline is worse than no call graph: without it every caller lives
    // inside the diff, and the XML says "nothing depends on this" about code
    // the repo calls in twenty places. Reporting that to the model is a lie.
    if (!graphPath) return null;

    const diffPath = path.join(cacheDir, 'pr.diff');
    try {
        await writeDiff(repoDir, baseSha, headSha, files, diffPath);
    } catch {
        return null;
    }

    const out = {};
    for (const format of ['xml', 'json']) {
        const dest = format === 'xml' ? xmlPath : jsonPath;
        try {
            await cli(
                [
                    'context',
                    '--files',
                    ...files,
                    '--repo-dir',
                    headDir,
                    '--graph',
                    graphPath,
                    '--diff',
                    diffPath,
                    '--format',
                    format,
                    '--out',
                    dest,
                ],
                CONTEXT_TIMEOUT_MS,
            );
            if (format === 'xml') out.xml = fs.readFileSync(dest, 'utf8');
        } catch (err) {
            log?.(
                `[callgraph] context --format ${format} failed: ${String(err).slice(0, 200)}`,
            );
        }
    }

    if (!out.xml) return null;
    return { xml: out.xml, json: trimContextFile(jsonPath, files, log) };
}

/** Node refuses to materialize a string past ~512MB, and `context --format
 *  json` dumps the ENTIRE merged graph: 817MB on the grafana
 *  notification-rule case. Parsing it whole is both impossible there and
 *  wasteful everywhere — `sitesFromCallGraph` reads the blast radius plus the
 *  edges with one end inside the diff, which is under 3MB in every case
 *  measured. Trim on write so nothing downstream ever meets the big file. */
const MAX_PARSEABLE_BYTES = 400 * 1024 * 1024;

function trimContextFile(jsonPath, files, log) {
    if (!fs.existsSync(jsonPath)) return null;
    const bytes = fs.statSync(jsonPath).size;

    const changed = new Set(
        files.map((f) => f.replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase()),
    );
    const inDiff = (fp) =>
        changed.has(
            String(fp || '').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase(),
        );

    let ctx;
    if (bytes <= MAX_PARSEABLE_BYTES) {
        try {
            ctx = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch (err) {
            log?.(`[callgraph] context.json unparseable: ${String(err).slice(0, 120)}`);
        }
    } else {
        log?.(`[callgraph] context.json is ${(bytes / 1e6).toFixed(0)}MB — analysis-only`);
    }

    if (!ctx) {
        // Fallback for a graph too large to hold in memory: keep the analysis
        // block alone. `sitesFromCallGraph` then derives each dependent's file
        // from its qualified_name (which is literally "<path>::<symbol>") and
        // loses only the line number and the per-site attribution.
        const analysis = extractAnalysisBlock(jsonPath);
        if (!analysis) return null;
        ctx = { analysis, graph: { nodes: [], edges: [] } };
    }

    const nodeFiles = new Map(
        (ctx.graph?.nodes || []).map((n) => [n.qualified_name, n.file_path]),
    );
    const keepQN = new Set();
    for (const entries of Object.values(ctx.analysis?.blast_radius?.by_depth || {})) {
        for (const e of entries) keepQN.add(e.qualified_name);
    }

    const trimmed = {
        analysis: ctx.analysis,
        graph: {
            nodes: (ctx.graph?.nodes || []).filter(
                (n) => keepQN.has(n.qualified_name) || inDiff(n.file_path),
            ),
            edges: (ctx.graph?.edges || []).filter(
                (e) =>
                    inDiff(nodeFiles.get(e.source_qualified)) ||
                    inDiff(nodeFiles.get(e.target_qualified)),
            ),
        },
        _compacted: true,
    };

    fs.writeFileSync(jsonPath, JSON.stringify(trimmed));
    return trimmed;
}

/** Pulls the top-level "analysis" object out of a file too big to parse.
 *  The writer is `JSON.stringify(output, null, 2)` with "graph" first, so the
 *  block starts at the last 2-space-indented `"analysis":` and runs to the
 *  final closing brace. */
function extractAnalysisBlock(jsonPath) {
    const fd = fs.openSync(jsonPath, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        // The analysis block is orders of magnitude smaller than the graph;
        // 64MB from the tail covers it with room to spare.
        const window = Math.min(size, 64 * 1024 * 1024);
        const buf = Buffer.alloc(window);
        fs.readSync(fd, buf, 0, window, size - window);
        const tail = buf.toString('utf8');
        const at = tail.lastIndexOf('\n  "analysis": ');
        if (at === -1) return null;
        const body = tail.slice(at + '\n  "analysis": '.length).trimEnd();
        // Drop the file's own closing brace.
        const end = body.lastIndexOf('}');
        try {
            return JSON.parse(body.slice(0, end));
        } catch {
            return null;
        }
    } finally {
        fs.closeSync(fd);
    }
}

module.exports = { buildPrCallGraph, baselineGraph, CACHE_ROOT };
