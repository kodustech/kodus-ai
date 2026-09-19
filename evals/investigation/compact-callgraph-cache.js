#!/usr/bin/env node
/**
 * Shrinks the call-graph cache in place.
 *
 * `kodus-graph context --format json` emits the whole MERGED graph — every node
 * and edge in the repository. That is 150-780MB per case, ~3GB for twenty, and
 * `sitesFromCallGraph` reads a sliver of it: the nodes named in the blast
 * radius, and the edges with one end inside the diff. Keeping the rest filled
 * the disk for nothing.
 *
 * Safe to re-run; skips a case already compacted, and never touches a case
 * whose context.json is still being written (no .xml sibling yet).
 */
const fs = require('fs');
const path = require('path');

const { CACHE_ROOT } = require('./build-pr-callgraph');
const DATASETS = path.join(__dirname, 'datasets');

function changedFilesFor(caseId) {
    for (const f of fs.readdirSync(DATASETS)) {
        if (!f.endsWith('.json')) continue;
        let vars;
        try {
            vars = JSON.parse(fs.readFileSync(path.join(DATASETS, f), 'utf8'))[0].vars;
        } catch {
            continue;
        }
        // The cache directory name is the caseId truncated to 80 chars
        // (build-pr-callgraph). Comparing the full id dropped 3 of the 30
        // cases to an EMPTY changed-file set, which silently discarded every
        // edge for them.
        if (vars.caseId !== caseId && vars.caseId.slice(0, 80) !== caseId) continue;
        const cf =
            typeof vars.changedFiles === 'string'
                ? JSON.parse(vars.changedFiles)
                : vars.changedFiles || [];
        return new Set(
            cf
                .map((x) => x?.filename || x?.previous_filename)
                .filter(Boolean)
                .map((p) => p.replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase()),
        );
    }
    return null;
}

function compact(ctx, changed) {
    const keepQN = new Set();
    for (const entries of Object.values(ctx?.analysis?.blast_radius?.by_depth || {})) {
        for (const e of entries) keepQN.add(e.qualified_name);
    }

    const inDiff = (fp) =>
        changed.has(String(fp || '').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase());

    const nodes = (ctx.graph?.nodes || []).filter(
        (n) => keepQN.has(n.qualified_name) || inDiff(n.file_path),
    );
    const nodeFiles = new Map(
        (ctx.graph?.nodes || []).map((n) => [n.qualified_name, n.file_path]),
    );
    const edges = (ctx.graph?.edges || []).filter(
        (e) =>
            inDiff(nodeFiles.get(e.source_qualified)) ||
            inDiff(nodeFiles.get(e.target_qualified)),
    );

    return {
        ...ctx,
        graph: { ...ctx.graph, nodes, edges },
        _compacted: true,
    };
}

const onlyFinished = process.argv.includes('--finished-only');
let freed = 0;
for (const dir of fs.readdirSync(CACHE_ROOT)) {
    if (dir.startsWith('_')) continue;
    const jsonPath = path.join(CACHE_ROOT, dir, 'context.json');
    const xmlPath = path.join(CACHE_ROOT, dir, 'context.xml');
    if (!fs.existsSync(jsonPath)) continue;
    // The xml is written first; no xml means context --format json may still be
    // streaming into this file.
    if (onlyFinished && !fs.existsSync(xmlPath)) continue;

    const before = fs.statSync(jsonPath).size;
    let ctx;
    try {
        ctx = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
        console.log(`${dir}: unreadable, skipping`);
        continue;
    }
    if (ctx._compacted) continue;

    const changed = changedFilesFor(dir) || new Set();
    const out = compact(ctx, changed);
    fs.writeFileSync(jsonPath, JSON.stringify(out));
    const after = fs.statSync(jsonPath).size;
    freed += before - after;
    console.log(
        `${dir}: ${(before / 1e6).toFixed(0)}MB -> ${(after / 1e6).toFixed(1)}MB  (nodes ${ctx.graph?.nodes?.length ?? 0}->${out.graph.nodes.length}, edges ${ctx.graph?.edges?.length ?? 0}->${out.graph.edges.length})`,
    );
}
console.log(`freed ${(freed / 1e9).toFixed(2)} GB`);
