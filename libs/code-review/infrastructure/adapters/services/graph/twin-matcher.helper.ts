export interface TwinCandidateRow {
    qualified_name: string;
    params: string;
    return_type: string;
    file_path: string;
    line_start: number;
    line_end: number;
    callees?: string[];
}

export function overlapRatio(candidateCallees: string[], prCallees: Set<string>): number {
    if (prCallees.size === 0) return 0;
    const hits = candidateCallees.filter((c) => prCallees.has(c)).length;
    return hits / prCallees.size;
}

/**
 * Mark duplicate pairs in-place on `graph.nodes`.
 *
 * Matches changed functions against every function in the graph: same
 * {name|type} param token-set (order-insensitive, lowercased), compatible
 * return types (NULL==NULL allowed), and at least one overlapping repo
 * callee. Sets `is_duplicate` + `duplicate_twin` on both members.
 */
export function pairDuplicateTwinsInGraph(
    graph: { nodes?: any[]; edges?: any[] },
    prEdges: { source_qualified: string; target_qualified: string; kind: string }[] = [],
    prNodes: any[] = [],
    fileChanges: Array<{ filename?: string; patch?: string }> = [],
): void {
    const nodes = graph.nodes ?? [];

    if (nodes.length < 2) return;

    // Sources = nodes the PR actually touched. The sandbox parses WHOLE
    // files, so every PR node (changed or not) is in prNodes. The diff's
    // added-line ranges (new-file side) pick out the ones with changed
    // lines. Sources can ONLY come from prNodes — they carry NEW-file line
    // numbers (the coordinate space hunks use). DB-only nodes carry OLD
    // lines and would false-match hunks.
    const addedRangesByFile = new Map<string, Array<[number, number]>>();
    for (const fc of fileChanges || []) {
        const path = fc?.filename;
        if (!path || !fc?.patch) continue;
        const ranges: Array<[number, number]> = [];
        let newStart = 0, newCount = 0, newLine = 0;
        for (const line of fc.patch.split('\n')) {
            const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
            if (hunk) {
                newStart = parseInt(hunk[1], 10);
                newCount = hunk[2] ? parseInt(hunk[2], 10) : 1;
                newLine = newStart;
                continue;
            }
            if (newLine === 0) continue; // pre-hunk header lines
            if (line.startsWith('+')) {
                ranges.push([newLine, newLine]);
                newLine++;
            } else if (line.startsWith('-')) {
                // deleted line — does not advance the new-file cursor
            } else {
                newLine++; // context line
            }
        }
        if (ranges.length) addedRangesByFile.set(path, ranges);
    }
    const lineHitsHunk = (filePath: string, lineStart: number, lineEnd: number) => {
        const normPath = (filePath || '');
        const ranges = addedRangesByFile.get(normPath);
        if (!ranges) return false;
        for (const [s, e] of ranges) {
            if (s >= lineStart && s <= lineEnd) return true;
        }
        return false;
    };

    // --- Tokenize params into {name|type} tokens (lowercased) ---
    const tokenize = (raw: unknown): Set<string> => {
        const s = typeof raw === 'string' ? raw : '';
        const tokens = new Set<string>();
        // Signed ({ a, b }: { a: T; b: U }): the trailing {…} holds the types.
        // Multiple destructures ({ a }, { b }): no head (`}:` absent) → keep all.
        const blocks = s.match(/\{[^{}]*\}/g) || [];
        const hasHead = blocks.some((b) => {
            let i = s.indexOf(b) + b.length;
            while (i < s.length && s[i] === ' ') i++;
            return s[i] === ':';
        });
        const ann = hasHead ? blocks[blocks.length - 1] : s;
        // name (optional `?`) : type — charset stops at `,;|=>}` so defaults,
        // unions, arrays, arrows leave the plain leading type.
        const colonMatches = ann.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:\s*([^,;|=>}]+)/g);
        for (const m of colonMatches) {
            tokens.add(`${m[1].toLowerCase()}|${m[2].trim().toLowerCase()}`);
        }
        // No colons → untyped (a, b): name-only tokens so they still match.
        if (tokens.size === 0) {
            for (const m of ann.matchAll(/([A-Za-z_$][\w$]*)/g)) {
                tokens.add(`${m[1].toLowerCase()}|`);
            }
        }
        return tokens;
    };

    const byQn = new Map<string, any>();
    for (const n of nodes) {
        if (n?.kind === 'Function' || n?.kind === 'Method') {
            byQn.set(n.qualified_name, n);
        }
    }

    // Skip if no patch data reached us (the hasPatches gate in the caller
    // should prevent this — belt-and-suspenders here).
    if (addedRangesByFile.size === 0) {
        return;
    }
    const changed = (prNodes || []).filter((n: any) => {
        const filePath = n?.file_path as string | undefined;
        if (!filePath) return false;
        // Source = a PR node (new-file lines) whose range intersects an
        // added hunk.
        return lineHitsHunk(filePath, n.line_start ?? 0, n.line_end ?? 0);
    });

    if (changed.length === 0) return;

    // Changed functions are those SQL pre-filtered (changed_functions); that
    // subset now narrows to functions with >=1 repo callee. Build callee sets
    // from the graph edges for the overlap requirement.
    const calleeOf = new Map<string, Set<string>>();
    const seedCallee = (from: string, to: string) => {
        if (!from) return;
        if (!calleeOf.has(from)) calleeOf.set(from, new Set<string>());
        calleeOf.get(from)!.add(to);
    };

    for (const e of graph?.edges || []) {
        if (e?.kind !== 'CALLS') continue;
        if (Boolean(e.source_qualified) && Boolean(e.target_qualified)) {
            seedCallee(e.source_qualified, e.target_qualified);
        }
    }

    // The overlap check needs each function's callee set — who does it call?
    // But the sandbox-side calls (the ones from new files) would be invisible if we only used graph.edges
    for (const e of prEdges || []) {
        if (e?.kind !== 'CALLS') continue;
        if (Boolean(e.source_qualified) && Boolean(e.target_qualified)) {
            seedCallee(e.source_qualified, e.target_qualified);
        }
    }

    // Pairs where the changed function is the "source" (twin is anywhere in repo).
    const seen = new Set<string>();
    const addPair = (a: any, b: any) => {
        if (!a || !b || a === b) return;
        const key = [...[a.qualified_name, b.qualified_name]].sort().join('|');
        if (seen.has(key)) return;
        seen.add(key);
        a.is_duplicate = true;
        b.is_duplicate = true;
        a.duplicate_twin = {
            qualified_name: b.qualified_name,
            file_path: b.file_path,
            line_start: b.line_start ?? 0,
            line_end: b.line_end ?? 0,
        };
        b.duplicate_twin = {
            qualified_name: a.qualified_name,
            file_path: a.file_path,
            line_start: a.line_start ?? 0,
            line_end: a.line_end ?? 0,
        };
    };

    for (const c of changed) {
        // changed function param
        const cTokens = tokenize(c.params);
        const cRet = c.return_type;
        if (cTokens.size === 0) continue; // unparseable/missing params — skip

        for (const other of byQn.values()) {
            if (other.qualified_name === c.qualified_name) continue;
            // Return-type compatibility (NULL==NULL allowed)
            if (cRet !== other.return_type &&
                !(cRet == null && other.return_type == null)) {
                continue;
            }
            // twin function param
            const oTokens = tokenize(other.params);
            if (oTokens.size === 0) continue;
            // Similarity: fraction of c's tokens present in o's set.
            // Providers rename params (payid vs csid), so exact equality is
            // too strict — allow >=50% overlap.
            let matched = 0;
            for (const tk of cTokens) {
                if (oTokens.has(tk)) matched++;
            }
            const similarity = matched / cTokens.size;
            if (similarity < 0.5) continue;
            // Overlapping repo callees. Require >=2 shared callees for generic similarity (0.50),
            // but allow minOverlap=1 when parameter token similarity is high (>=0.70).
            const cc = calleeOf.get(c.qualified_name) ?? new Set<string>();
            const oc = calleeOf.get(other.qualified_name) ?? new Set<string>();
            let overlap = 0;
            for (const cal of cc) {
                if (oc.has(cal)) overlap++;
            }
            const minOverlap = similarity >= 0.7 ? 1 : 2;
            if (overlap < minOverlap) continue;
            addPair(c, other);
        }
    }
}

/**
 * Format duplicate twin nodes as XML block `<DuplicateCandidates>`.
 */
export function formatDuplicateCandidatesXml(twins: any[]): string {
    if (!twins || twins.length === 0) return '';

    const twinLines = twins.map((t) => {
        const twin = t.duplicate_twin;
        const first = `${t.qualified_name ?? `${t.file_path}::${t.name}`}:${t.line_start}-${t.line_end}`;
        const second = twin
            ? `${twin.qualified_name ?? `${twin.file_path}::${twin.name}`}:${twin.line_start ?? 0}-${twin.line_end ?? 0}`
            : first;
        return `    <TwinPair first="${first}" second="${second}" />`;
    });

    return `\n  <DuplicateCandidates>\n${twinLines.join('\n')}\n  </DuplicateCandidates>`;
}
