// Valid right-side line ranges from the engine's patchWithLinesStr. Mirrors
// extractValidDiffLines (which parses a raw unified patch) — the benchmark
// datasets carry patchWithLinesStr, whose `NN +code`/`NN  code` lines ARE the
// right-side lines. Produces the same [start,end] hunk spans the real function
// would, so the snapLinesToDiff decision under test is identical.
function validRangesFromEnginePatch(patchWithLinesStr) {
    const ranges = [];
    let cur = null;
    for (const ln of String(patchWithLinesStr || '').split('\n')) {
        if (/^__old hunk__/.test(ln)) { if (cur) { ranges.push(cur); cur = null; } continue; }
        if (/^__new hunk__/.test(ln) || /^@@ /.test(ln) || /^## file:/.test(ln)) { if (cur) { ranges.push(cur); cur = null; } continue; }
        const m = ln.match(/^\s*(\d+)\s/); // right-side line number (added or context)
        if (!m) { if (cur) { ranges.push(cur); cur = null; } continue; }
        const n = +m[1];
        if (cur && n === cur[1] + 1) cur[1] = n;
        else { if (cur) ranges.push(cur); cur = [n, n]; }
    }
    if (cur) ranges.push(cur);
    return ranges;
}

module.exports = { validRangesFromEnginePatch };
