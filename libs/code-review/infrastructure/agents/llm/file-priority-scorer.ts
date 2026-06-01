import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import { CoverageTier, normalizeRepoPath } from './coverage-ledger';

/**
 * Minimal shape of the AST call graph JSON produced by kodus-graph.
 * Uses `unknown` at the array-element level so callers can pass any shape
 * (the pipeline context types node/edge as `any`); we narrow internally.
 */
export interface CallGraphJsonLike {
    nodes?: unknown[];
    edges?: unknown[];
}

interface NodeLike {
    qualified_name?: string;
    file_path?: string;
    kind?: string;
    is_test?: boolean;
}

interface EdgeLike {
    kind?: string;
    source_qualified?: string;
    target_qualified?: string;
}

export interface FileScore {
    file: string;
    score: number;
    diffMultiplier: number;
    statusMult: number;
    structuralWeight: number;
    weightedInDegree: number;
    callsIn: number;
    importsIn: number;
    typeIn: number; // INHERITS + IMPLEMENTS
}

const STATUS_MULT: Record<string, number> = {
    added: 1.2,
    modified: 1.0,
    renamed: 0.3,
    removed: 0.1,
};

/**
 * Edge-kind weights when summing in-degree for the structural bonus.
 * Calibrated against real graph data on kodus-ai-cr: CALLS are the dominant
 * cross-file signal (~70% of cross-file edges) and carry the highest
 * blast-radius. Type-hierarchy edges matter less in absolute numbers but
 * break contracts when the parent changes. Plain IMPORTS get the smallest
 * weight — importing is cheap, breaking a CALL target is expensive.
 * CONTAINS is always same-file in practice and TESTED_BY only helps tests,
 * so both are ignored.
 */
const EDGE_KIND_WEIGHTS: Record<string, number> = {
    CALLS: 3,
    INHERITS: 2,
    IMPLEMENTS: 2,
    IMPORTS: 1,
};

/**
 * Compute a priority score per changed file from structural signals only:
 *   score = diffMultiplier × statusMult × structuralWeight
 *
 * diffMultiplier:     log2-normalized change size vs the largest file in
 *                     the PR, mapped to [0.5, 1.5].
 * statusMult:         table lookup on git file status.
 * structuralWeight:   [1.0, 2.0] bonus from AST call-graph in-degree within
 *                     the PR universe, weighted by edge kind. Falls back
 *                     to 1.0 when no graph is available or when the file
 *                     is not referenced by any other changed file.
 *
 * Scores are comparable within a single PR — do not compare across PRs.
 */
export function computeFileScores(
    files: FileChange[],
    callGraphJson?: CallGraphJsonLike,
): Map<string, FileScore> {
    const result = new Map<string, FileScore>();
    if (!files?.length) return result;

    const sizeLds = files.map((f) =>
        Math.log2((f.additions || 0) + (f.deletions || 0) + 1),
    );
    const maxLd = Math.max(...sizeLds, 1);

    const changedFiles = new Set(
        files.map((f) => normalizeRepoPath(f.filename)).filter(Boolean),
    );

    // Map qualified_name → owning file (qualified_name is formatted as
    // "file_path::Symbol", so we could also split on "::", but the node
    // table is authoritative and handles edge cases like nested types).
    const qnToFile = new Map<string, string>();
    if (callGraphJson?.nodes) {
        for (const raw of callGraphJson.nodes) {
            const node = raw as NodeLike;
            const qn = node?.qualified_name;
            const fp = normalizeRepoPath(node?.file_path);
            if (qn && fp) qnToFile.set(qn, fp);
        }
    }

    // Per-file weighted in-degree split by kind. Only edges where both
    // endpoints are changed files in this PR count — we're measuring
    // in-PR blast radius, not global centrality.
    const callsByFile = new Map<string, number>();
    const importsByFile = new Map<string, number>();
    const typeByFile = new Map<string, number>();

    if (callGraphJson?.edges && qnToFile.size > 0) {
        for (const raw of callGraphJson.edges) {
            const edge = raw as EdgeLike;
            const weight = EDGE_KIND_WEIGHTS[edge?.kind || ''];
            if (!weight) continue;
            const srcFile = qnToFile.get(edge?.source_qualified || '');
            const tgtFile = qnToFile.get(edge?.target_qualified || '');
            if (!srcFile || !tgtFile) continue;
            if (srcFile === tgtFile) continue;
            if (!changedFiles.has(srcFile) || !changedFiles.has(tgtFile)) {
                continue;
            }
            const bucket =
                edge.kind === 'CALLS'
                    ? callsByFile
                    : edge.kind === 'IMPORTS'
                      ? importsByFile
                      : typeByFile;
            bucket.set(tgtFile, (bucket.get(tgtFile) || 0) + 1);
        }
    }

    // Compute weighted in-degree and the maximum for log-normalization.
    // Log2 smooths the long tail — in real graphs one "super-hub" file
    // can have 100× the in-degree of the median, and linear normalization
    // leaves everyone else with negligible bonus.
    const weightedByFile = new Map<string, number>();
    for (const file of changedFiles) {
        const weighted =
            (callsByFile.get(file) || 0) * EDGE_KIND_WEIGHTS.CALLS +
            (typeByFile.get(file) || 0) * EDGE_KIND_WEIGHTS.INHERITS +
            (importsByFile.get(file) || 0) * EDGE_KIND_WEIGHTS.IMPORTS;
        if (weighted > 0) {
            weightedByFile.set(file, weighted);
        }
    }
    const maxWeighted = Math.max(1, ...Array.from(weightedByFile.values()));
    const logMax = Math.log2(1 + maxWeighted);

    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const file = normalizeRepoPath(f.filename);
        if (!file) continue;

        const diffMultiplier = 0.5 + (sizeLds[i] / maxLd) * 1.0;
        const statusMult =
            STATUS_MULT[String(f.status || 'modified').toLowerCase()] ?? 1.0;

        const weightedInDegree = weightedByFile.get(file) || 0;
        const structuralBonus =
            weightedInDegree > 0 && logMax > 0
                ? Math.log2(1 + weightedInDegree) / logMax
                : 0;
        const structuralWeight = 1.0 + structuralBonus; // [1.0, 2.0]

        const score = diffMultiplier * statusMult * structuralWeight;

        result.set(file, {
            file,
            score,
            diffMultiplier,
            statusMult,
            structuralWeight,
            weightedInDegree,
            callsIn: callsByFile.get(file) || 0,
            importsIn: importsByFile.get(file) || 0,
            typeIn: typeByFile.get(file) || 0,
        });
    }

    return result;
}

export interface AssignTiersOptions {
    /** Top fraction of files taken as critical (default 0.2). */
    criticalTopPct?: number;
    /** Cumulative top fraction taken as critical+warm (default 0.5).
     *  Warm band = warmTopPct - criticalTopPct. */
    warmTopPct?: number;
    /** Any file with score at or above this floor is promoted to critical
     *  regardless of percentile (default 1.5). */
    criticalAbsMin?: number;
    /** Any file with score at or above this floor is at least warm
     *  (default 0.9). */
    warmAbsMin?: number;
}

/**
 * Split files into critical / warm / optional tiers by score.
 *
 *   critical = (top criticalTopPct) ∪ (score ≥ criticalAbsMin)
 *   warm     = (top warmTopPct minus critical) ∪ (score ≥ warmAbsMin minus critical)
 *   optional = everything else
 */
export function assignFileTiers(
    scores: Map<string, FileScore>,
    opts: AssignTiersOptions = {},
): Map<string, CoverageTier> {
    const criticalTopPct = opts.criticalTopPct ?? 0.2;
    // 0.35 cumulative = 20% critical + 15% warm. Tighter than the
    // initial 0.5 default because the earlier benchmark showed the
    // agent used extra readFile calls to compensate for hunk-only
    // optional files — a smaller warm band means more full-diff
    // files, but crucially optional is also smaller in absolute
    // terms only as a consequence, not the goal.
    const warmTopPct = opts.warmTopPct ?? 0.35;
    const criticalAbsMin = opts.criticalAbsMin ?? 1.5;
    const warmAbsMin = opts.warmAbsMin ?? 0.9;

    const tiers = new Map<string, CoverageTier>();
    const entries = Array.from(scores.values()).sort(
        (a, b) => b.score - a.score,
    );
    if (!entries.length) return tiers;

    const criticalCount = Math.max(1, Math.ceil(entries.length * criticalTopPct));
    const warmCountCumulative = Math.max(
        criticalCount,
        Math.ceil(entries.length * warmTopPct),
    );

    for (let i = 0; i < entries.length; i++) {
        if (i < criticalCount) {
            tiers.set(entries[i].file, 'critical');
        } else if (i < warmCountCumulative) {
            tiers.set(entries[i].file, 'warm');
        } else {
            tiers.set(entries[i].file, 'optional');
        }
    }

    // Absolute floors override percentile placement — a file with very
    // high score in a small PR still deserves critical status, and a
    // file with moderate centrality should at least be warm even if the
    // warm band was tight.
    for (const entry of entries) {
        if (entry.score >= criticalAbsMin) {
            tiers.set(entry.file, 'critical');
        } else if (
            entry.score >= warmAbsMin &&
            tiers.get(entry.file) !== 'critical'
        ) {
            tiers.set(entry.file, 'warm');
        }
    }

    return tiers;
}

/**
 * Convenience wrapper: returns just the critical set (same semantics as
 * before the 3-tier refactor, useful for callers that only need the
 * must-inspect subset).
 */
export function selectCriticalFiles(
    scores: Map<string, FileScore>,
    opts: AssignTiersOptions = {},
): Set<string> {
    const tiers = assignFileTiers(scores, opts);
    const critical = new Set<string>();
    for (const [file, tier] of tiers) {
        if (tier === 'critical') critical.add(file);
    }
    return critical;
}
