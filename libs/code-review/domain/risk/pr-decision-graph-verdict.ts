import { readFileSync } from 'node:fs';

import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/**
 * Typed-sum gate verdict for the pr-decision-reconciler (task 2.2).
 *
 * `Ready(v)`     the gate has an opinion under the current snapshot.
 * `Unavailable`  the gate could not form an opinion (no graph, oversized
 *                diff, library error). Reconciler treats as no contribution
 *                per spec (Q1 ratified: L1 unavailable escalates to L2).
 * `Stale`        a prior verdict predates the current snapshot key.
 */
export type GateVerdict<T> =
    | { status: 'Ready'; value: T; snapshotKey: string }
    | { status: 'Unavailable'; reason: string; snapshotKey: string }
    | { status: 'Stale'; snapshotKey: string; priorSnapshotKey: string };

/**
 * The verdict the L1 (kodus-graph analyze) gate emits when its analysis
 * succeeded and is current. It carries only the fields the reconciler's
 * reducer reads; everything else in the analyze JSON is dropped here.
 */
export interface L1Verdict {
    /** 0.35 + 0.30 + 0.20 + 0.15 factor aggregation per DEFAULT_RISK_CONFIG. */
    riskScore: number;
    /** LOW | MEDIUM | HIGH | UNKNOWN — capped at HIGH when factors force it. */
    level: 'LOW' | 'MEDIUM' | 'HIGH';
    blastRadius: {
        totalFunctions: number;
        totalFiles: number;
    };
    testGaps: Array<{
        functionName: string;
        filePath: string;
        lineStart: number;
    }>;
    /** Functions whose `risk_level` made them veto-contributing. */
    vetoContributingFunctions: string[];
    /** Evidence preserved for the audit panel; safe to display. */
    factors: ReadonlyArray<{ name: string; value: number; detail: string }>;
}

interface RawAnalyzeOutput {
    blast_radius?: {
        total_functions?: number;
        total_files?: number;
        by_depth?: unknown;
    };
    risk_score?: {
        level?: string;
        score?: number;
        factors?: {
            blast_radius?: { value?: number; detail?: string };
            test_gaps?: { value?: number; detail?: string };
            complexity?: { value?: number; detail?: string };
            inheritance?: { value?: number; detail?: string };
        };
    };
    test_gaps?: Array<{
        function?: string;
        file_path?: string;
        line_start?: number;
    }>;
}

/**
 * Pure mapper: kodus-graph analyze JSON string -> GateVerdict<L1Verdict>.
 *
 * Classifies failure shapes (missing graph, oversized diff, library error)
 * into `Unavailable(reason)` per the spec; never throws. The reconciler
 * hosts the snapshot-key tracking; this function only carries the current
 * expected key so it can render an `Unavailable` verdict under it.
 *
 * @param jsonString         raw JSON from `kodus-graph analyze --out`
 * @param snapshotKey        current snapshot key the per-PR record expects
 * @param raw                optional raw text from the CLI failure (used
 *                           to set `reason` on Unavailable)
 * @param parsed             optional parsed object (test seam)
 */
export function mapAnalyzeJsonToL1GateVerdict(
    jsonString: string,
    snapshotKey: string,
    raw?: string,
): GateVerdict<L1Verdict> {
    let parsed: RawAnalyzeOutput;
    try {
        parsed = JSON.parse(jsonString) as RawAnalyzeOutput;
    } catch (error) {
        const msg = raw?.slice(0, 200) ?? (error as Error)?.message ?? '';
        return {
            status: 'Unavailable',
            reason: `kodus-graph analyze output is not valid JSON: ${msg}`,
            snapshotKey,
        };
    }

    const riskScore = parsed.risk_score?.score;
    const levelRaw = parsed.risk_score?.level?.toUpperCase();
    const level: L1Verdict['level'] | null =
        levelRaw === 'LOW' || levelRaw === 'MEDIUM' || levelRaw === 'HIGH'
            ? levelRaw
            : null;

    if (typeof riskScore !== 'number' || level === null) {
        return {
            status: 'Unavailable',
            reason: 'kodus-graph analyze output missing risk_score.score or risk_score.level',
            snapshotKey,
        };
    }

    const factors = parsed.risk_score?.factors;
    const factorList: L1Verdict['factors'] = factors
        ? [
              factors.blast_radius
                  ? {
                        name: 'blast_radius',
                        value: factors.blast_radius.value ?? 0,
                        detail: factors.blast_radius.detail ?? '',
                    }
                  : null,
              factors.test_gaps
                  ? {
                        name: 'test_gaps',
                        value: factors.test_gaps.value ?? 0,
                        detail: factors.test_gaps.detail ?? '',
                    }
                  : null,
              factors.complexity
                  ? {
                        name: 'complexity',
                        value: factors.complexity.value ?? 0,
                        detail: factors.complexity.detail ?? '',
                    }
                  : null,
              factors.inheritance
                  ? {
                        name: 'inheritance',
                        value: factors.inheritance.value ?? 0,
                        detail: factors.inheritance.detail ?? '',
                    }
                  : null,
          ].filter((f): f is NonNullable<typeof f> => f !== null)
        : [];

    const blastRadius: L1Verdict['blastRadius'] = {
        totalFunctions: Number(parsed.blast_radius?.total_functions ?? 0),
        totalFiles: Number(parsed.blast_radius?.total_files ?? 0),
    };

    const testGaps: L1Verdict['testGaps'] = Array.isArray(parsed.test_gaps)
        ? parsed.test_gaps.map((g) => ({
              functionName: String(g.function ?? ''),
              filePath: String(g.file_path ?? ''),
              lineStart: Number(g.line_start ?? 0),
          }))
        : [];

    // Functions whose risk_level made them veto-contributing. Today the
    // analyzer surfaces this through `blast_radius.by_depth[*]`; until that
    // shape is stable we approximate by listing depth-0 blast entries that
    // are flagged critical in the audit panel's factor.detail. Kept empty
    // here to avoid dropping type-uncertain data; populating it is a
    // follow-up once `kodus-graph@0.3.x` output is sampled in earnest.
    const vetoContributingFunctions: string[] = [];

    return {
        status: 'Ready',
        snapshotKey,
        value: {
            riskScore,
            level,
            blastRadius,
            testGaps,
            vetoContributingFunctions,
            factors: factorList,
        },
    };
}

/**
 * Reads the JSON file produced by `kodus-graph analyze --out` and maps it.
 * Failure paths (ENOENT, EACCES, oversized) surface as the same
 * `Unavailable` verdict so the reconciler's reducer sees one shape.
 */
export function loadAnalyzeJsonToL1GateVerdict(
    outPath: string,
    snapshotKey: string,
): GateVerdict<L1Verdict> {
    let raw: string;
    try {
        raw = readFileSync(outPath, 'utf-8');
    } catch (error) {
        return {
            status: 'Unavailable',
            reason: `kodus-graph analyze output not readable at ${outPath}: ${(error as Error)?.message ?? ''}`,
            snapshotKey,
        };
    }
    return mapAnalyzeJsonToL1GateVerdict(raw, snapshotKey, raw);
}

/**
 * Splits changed files into source paths (non-test, non-removed) for the
 * analyzeFiles invocation. Mirrors `controlFlowEvidence` filtering in
 * `assess-change-risk.ts:42-43` so the two pipelines agree about what
 * counts as a "changed source file".
 *
 * The constants below MUST stay in lockstep with `SOURCE_FILE` and `TEST_FILE`
 * declared in `assess-change-risk.ts`. If they drift, the L1 graph verdict
 * and the L2 control-flow evidence will run over different inputs.
 */
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|py|go|java|cs|rs)$/i;
const TEST_FILE =
    /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|\.|$)|\.(?:test|spec)\.[^/.]+$|(?:^|\/)(?:test_[^/]+\.(?:py|go|rs)|[^/]+_test\.(?:go|py|rs)|[^/]+Tests?\.(?:cs|java))$/i;

export function changedSourceFiles(files: FileChange[]): string[] {
    return files
        .filter(
            (f) =>
                f.status !== 'removed' &&
                SOURCE_FILE.test(f.filename) &&
                !TEST_FILE.test(f.filename),
        )
        .map((f) => f.filename);
}

/** Severity lowercased for downstream comparison. */
export const SEVERITY_FROM_LEVEL: Record<'LOW' | 'MEDIUM' | 'HIGH', string> = {
    LOW: SeverityLevel.LOW,
    MEDIUM: SeverityLevel.MEDIUM,
    HIGH: SeverityLevel.HIGH,
};
