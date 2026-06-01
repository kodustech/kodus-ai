import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

export interface CoverageTouch {
    tool: string;
    path: string;
    step: number;
}

export type CoverageTier = 'critical' | 'warm' | 'optional';

export interface CoverageTarget {
    id: string;
    file: string;
    /**
     * Hunks from the PR diff. A file is only fully covered once every
     * changed range is contained inside `touchedRanges`.
     */
    changedRanges: Array<[number, number]>;
    /**
     * Merged union of line ranges the agent has actually read with
     * readFile on this file. Status derives from how much of
     * `changedRanges` lives inside this union — coverage is per-hunk, not
     * per-file, so reading one small slice of a multi-hunk file no longer
     * flips the whole thing to `touched`.
     */
    touchedRanges: Array<[number, number]>;
    status: 'pending' | 'touched';
    touchedBy: CoverageTouch[];
    /** Undefined when tiering is disabled (flat coverage mode). */
    tier?: CoverageTier;
}

export interface CoverageSummary {
    totalTargets: number;
    touchedTargets: number;
    pendingTargets: number;
    touchedFiles: string[];
    pendingFiles: string[];
    // Tier counters (0 when tiering disabled).
    criticalTotal: number;
    criticalTouched: number;
    criticalPending: number;
    warmTotal: number;
    warmTouched: number;
    warmPending: number;
    optionalTotal: number;
    optionalTouched: number;
    optionalPending: number;
}

export interface BuildCoverageLedgerOptions {
    /** Map of normalized filename to tier. When provided, every target
     *  receives the matching tier ('critical' | 'warm' | 'optional').
     *  Files absent from the map are treated as 'optional'. When this
     *  option is omitted, targets are untiered (flat coverage mode). */
    fileTiers?: Map<string, CoverageTier>;
}

/** Total coverage fraction required when tiering is active. */
export const TIERED_TOTAL_COVERAGE_THRESHOLD = 0.7;

interface CoverageObservation {
    path: string;
    startLine?: number;
    endLine?: number;
    pathMode: 'file' | 'directory';
}

export function normalizeRepoPath(path?: string): string {
    return String(path || '')
        .replace(/^\/+/, '')
        .replace(/\\/g, '/')
        .trim();
}

export function buildCoverageLedger(
    changedFiles?: FileChange[],
    opts?: BuildCoverageLedgerOptions,
): CoverageTarget[] {
    if (!changedFiles?.length) return [];
    const fileTiers = opts?.fileTiers;
    const tiered = !!fileTiers;

    return changedFiles
        .filter((file) => !!file?.filename)
        .map((file) => {
            const normalized = normalizeRepoPath(file.filename);
            const tier: CoverageTier | undefined = tiered
                ? (fileTiers!.get(normalized) ?? 'optional')
                : undefined;
            return {
                id: normalized,
                file: normalized,
                changedRanges: extractChangedLineRanges(file.patch),
                touchedRanges: [],
                status: 'pending' as const,
                touchedBy: [],
                tier,
            };
        });
}

export function getCoverageSummary(targets: CoverageTarget[]): CoverageSummary {
    const touched = targets.filter((t) => t.status === 'touched');
    const pending = targets.filter((t) => t.status === 'pending');

    const critical = targets.filter((t) => t.tier === 'critical');
    const warm = targets.filter((t) => t.tier === 'warm');
    const optional = targets.filter((t) => t.tier === 'optional');

    return {
        totalTargets: targets.length,
        touchedTargets: touched.length,
        pendingTargets: pending.length,
        touchedFiles: touched.map((t) => t.file),
        pendingFiles: pending.map((t) => t.file),
        criticalTotal: critical.length,
        criticalTouched: critical.filter((t) => t.status === 'touched').length,
        criticalPending: critical.filter((t) => t.status === 'pending').length,
        warmTotal: warm.length,
        warmTouched: warm.filter((t) => t.status === 'touched').length,
        warmPending: warm.filter((t) => t.status === 'pending').length,
        optionalTotal: optional.length,
        optionalTouched: optional.filter((t) => t.status === 'touched').length,
        optionalPending: optional.filter((t) => t.status === 'pending').length,
    };
}

/**
 * Finalization gate. When tiering is active, the contract is:
 *   all critical files covered AND total coverage >= 70%.
 * Warm files count toward the 70% total but are not individually
 * required; optional files count toward total too but are strictly
 * best-effort. When tiering is disabled, falls back to the legacy
 * all-files-covered contract.
 */
export function isCoverageSatisfied(summary: CoverageSummary): boolean {
    if (summary.totalTargets === 0) return true;
    const tieringActive =
        summary.criticalTotal > 0 ||
        summary.warmTotal > 0 ||
        summary.optionalTotal > 0;
    if (!tieringActive) {
        return summary.pendingTargets === 0;
    }
    if (summary.criticalPending > 0) return false;
    const totalRatio = summary.touchedTargets / summary.totalTargets;
    return totalRatio >= TIERED_TOTAL_COVERAGE_THRESHOLD;
}

export function formatCoverageTargetsForPrompt(
    changedFiles?: FileChange[],
    maxItems = 20,
    opts?: BuildCoverageLedgerOptions,
): string {
    const targets = buildCoverageLedger(changedFiles, opts);
    if (!targets.length) return '';

    const hasTiers = targets.some((t) => t.tier);
    if (!hasTiers) {
        const lines = targets
            .slice(0, maxItems)
            .map((t) => `- ${describeCoverageTarget(t)}`);
        if (targets.length > maxItems) {
            lines.push(
                `- ... (${targets.length - maxItems} more changed files)`,
            );
        }
        return lines.join('\n');
    }

    const critical = targets.filter((t) => t.tier === 'critical');
    const warm = targets.filter((t) => t.tier === 'warm');
    const optional = targets.filter((t) => t.tier === 'optional');
    const blocks: string[] = [];

    const appendTier = (
        label: string,
        group: CoverageTarget[],
        hint: string,
    ) => {
        if (!group.length) return;
        if (blocks.length) blocks.push('');
        blocks.push(`${label} files (${group.length}) — ${hint}:`);
        const lines = group
            .slice(0, maxItems)
            .map((t) => `- ${describeCoverageTarget(t)}`);
        if (group.length > maxItems) {
            lines.push(
                `- ... (${group.length - maxItems} more ${label.toLowerCase()} files)`,
            );
        }
        blocks.push(...lines);
    };

    appendTier(
        'CRITICAL',
        critical,
        'every hunk listed must be readFile-covered before finalizing',
    );
    appendTier(
        'WARM',
        warm,
        'full diff above; readFile the hunks if budget allows — partial reads count per-hunk',
    );
    appendTier(
        'OPTIONAL',
        optional,
        'hunk headers only; readFile only if a concrete hypothesis points to them',
    );
    blocks.push(
        '',
        `Finalization rule: ALL critical files must be fully hunk-covered, AND total coverage must reach >= ${Math.round(TIERED_TOTAL_COVERAGE_THRESHOLD * 100)}%. Warm/optional contribute to the total.`,
        'Hunk-covered = every line range listed for the file has been inside a readFile range. Reading the first hunk of a multi-hunk file does NOT cover the rest.',
    );
    return blocks.join('\n');
}

export function formatCoverageDebt(
    targets: CoverageTarget[],
    maxItems = 8,
): string {
    const pending = targets.filter((t) => t.status === 'pending');
    if (!pending.length) return '';

    const hasTiers = targets.some((t) => t.tier);

    if (!hasTiers) {
        const lines = pending
            .slice(0, maxItems)
            .map((t) => `- ${describeCoverageDebtTarget(t)}`);
        if (pending.length > maxItems) {
            lines.push(
                `- ... (${pending.length - maxItems} more changed files)`,
            );
        }
        return [
            'Coverage debt remains for these hunks:',
            ...lines,
            'Do not finalize until the pending line ranges above have been inspected with readFile.',
            'grep or listDir alone do not count as coverage.',
        ].join('\n');
    }

    const summary = getCoverageSummary(targets);
    const criticalPending = pending.filter((t) => t.tier === 'critical');
    const warmPending = pending.filter((t) => t.tier === 'warm');
    const optionalPending = pending.filter((t) => t.tier === 'optional');
    const pct =
        summary.totalTargets > 0
            ? Math.round(
                  (summary.touchedTargets / summary.totalTargets) * 100,
              )
            : 0;

    const blocks: string[] = ['Coverage status:'];

    if (criticalPending.length) {
        const lines = criticalPending
            .slice(0, maxItems)
            .map((t) => `  - ${describeCoverageDebtTarget(t)}`);
        if (criticalPending.length > maxItems) {
            lines.push(
                `  - ... (${criticalPending.length - maxItems} more)`,
            );
        }
        blocks.push(
            `CRITICAL pending (${criticalPending.length}/${summary.criticalTotal}) — readFile the pending line ranges below before finalizing:`,
            ...lines,
        );
    } else if (summary.criticalTotal > 0) {
        blocks.push(
            `CRITICAL pending: 0/${summary.criticalTotal} — all critical files covered.`,
        );
    }

    if (warmPending.length) {
        const lines = warmPending
            .slice(0, Math.min(maxItems, 5))
            .map((t) => `  - ${describeCoverageDebtTarget(t)}`);
        if (warmPending.length > 5) {
            lines.push(`  - ... (${warmPending.length - 5} more)`);
        }
        blocks.push(
            `WARM pending (${warmPending.length}/${summary.warmTotal}) — readFile the pending line ranges below if step budget allows:`,
            ...lines,
        );
    }

    if (optionalPending.length) {
        blocks.push(
            `OPTIONAL pending: ${optionalPending.length}/${summary.optionalTotal} (diffs shown as hunk headers only; readFile only if a concrete hypothesis points to one of them).`,
        );
    }

    blocks.push(
        `Total coverage: ${summary.touchedTargets}/${summary.totalTargets} files fully covered (${pct}%).`,
        `A file is "covered" only when every hunk in the diff has been readFile'd. Reading one hunk of a multi-hunk file leaves the rest pending.`,
        `You may finalize once ALL critical files are covered AND total coverage >= ${Math.round(TIERED_TOTAL_COVERAGE_THRESHOLD * 100)}%.`,
        'readFile counts as coverage; grep/listDir do not.',
    );

    return blocks.join('\n');
}

export function markCoverageFromToolCall(
    targets: CoverageTarget[],
    toolName: string,
    args: Record<string, unknown>,
    step: number,
): CoverageTarget[] {
    if (!targets.length) return [];

    const observation = extractCoverageObservation(toolName, args);
    if (!observation) return [];

    const normalizedPath = normalizeRepoPath(observation.path);
    if (!normalizedPath) return [];

    const newlyTouched: CoverageTarget[] = [];

    for (const target of targets) {
        if (!pathsMatch(target.file, normalizedPath)) continue;

        if (
            !target.touchedBy.some(
                (touch) =>
                    touch.tool === toolName && touch.path === normalizedPath,
            )
        ) {
            target.touchedBy.push({
                tool: toolName,
                path: normalizedPath,
                step,
            });
        }

        // Accumulate the read range into the target's touched-range union.
        // A readFile without line info is treated as a full-file read — it
        // covers every hunk regardless of where they fall.
        if (observation.startLine || observation.endLine) {
            const readStart = observation.startLine || 1;
            const readEnd =
                observation.endLine ||
                observation.startLine ||
                readStart;
            target.touchedRanges = mergeRanges([
                ...target.touchedRanges,
                [readStart, readEnd],
            ]);
        } else {
            // No line info → mark as fully read (single range covering
            // the union of all declared changed ranges, if any).
            target.touchedRanges = [[1, Number.MAX_SAFE_INTEGER]];
        }

        const wasPending = target.status === 'pending';
        if (isTargetFullyCovered(target)) {
            target.status = 'touched';
            if (wasPending) newlyTouched.push(target);
        }
    }

    return newlyTouched;
}

/**
 * A target is fully covered when every declared hunk is inside the merged
 * touched-range union. Targets without explicit changed ranges (e.g. binary
 * files, renames with no patch) flip to touched on any read.
 */
function isTargetFullyCovered(target: CoverageTarget): boolean {
    if (!target.changedRanges.length) {
        return target.touchedRanges.length > 0;
    }
    return target.changedRanges.every((range) =>
        isRangeCoveredByUnion(range, target.touchedRanges),
    );
}

function isRangeCoveredByUnion(
    range: [number, number],
    union: Array<[number, number]>,
): boolean {
    return union.some(([start, end]) => start <= range[0] && end >= range[1]);
}

/**
 * Return the subset of a target's changed ranges that has NOT yet been
 * fully covered by reads. Used by the coverage-debt prompt so the agent
 * knows which specific line ranges still need inspection.
 */
function pendingHunks(target: CoverageTarget): Array<[number, number]> {
    if (!target.changedRanges.length) {
        return target.touchedRanges.length ? [] : [];
    }
    return target.changedRanges.filter(
        (range) => !isRangeCoveredByUnion(range, target.touchedRanges),
    );
}

function mergeRanges(
    ranges: Array<[number, number]>,
): Array<[number, number]> {
    if (ranges.length <= 1) return ranges.slice();
    const sorted = ranges
        .map<[number, number]>(([s, e]) => [Math.min(s, e), Math.max(s, e)])
        .sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        const prev = merged[merged.length - 1];
        const cur = sorted[i];
        // Contiguous or overlapping ranges are merged. `+1` covers the
        // case where the agent reads [1,50] then [51,100] — those are
        // adjacent, not overlapping, but cover a continuous region.
        if (cur[0] <= prev[1] + 1) {
            prev[1] = Math.max(prev[1], cur[1]);
        } else {
            merged.push(cur);
        }
    }
    return merged;
}

function extractCoverageObservation(
    toolName: string,
    args: Record<string, unknown>,
): CoverageObservation | null {
    if (toolName === 'readFile') {
        const path = String(args.path || args.filePath || args.file || '');
        if (!path) return null;

        return {
            path,
            startLine: toPositiveNumber(args.startLine || args.start_line),
            endLine: toPositiveNumber(args.endLine || args.end_line),
            pathMode: 'file',
        };
    }

    return null;
}

function describeCoverageTarget(target: CoverageTarget): string {
    const ranges = formatRanges(target.changedRanges, 'changed lines');
    return ranges ? `${target.file} (${ranges})` : target.file;
}

/**
 * Debt-time description: show only the hunks that are still pending,
 * so the agent can read those specific line ranges instead of re-opening
 * sections it already covered.
 */
function describeCoverageDebtTarget(target: CoverageTarget): string {
    const pending = pendingHunks(target);
    if (!pending.length) {
        return target.changedRanges.length
            ? `${target.file} (all hunks covered)`
            : target.file;
    }
    const ranges = formatRanges(pending, 'pending lines');
    return ranges ? `${target.file} (${ranges})` : target.file;
}

function formatRanges(
    ranges: Array<[number, number]>,
    label: string,
): string {
    if (!ranges.length) return '';

    return `${label} ${ranges
        .slice(0, 3)
        .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
        .join(', ')}${ranges.length > 3 ? ', ...' : ''}`;
}

function pathsMatch(targetFile: string, observedPath: string): boolean {
    if (targetFile === observedPath) return true;
    // Suffix match with a leading '/' is safe: it only fires when the
    // observed path is a full suffix at a directory boundary, so
    // `foo/bar.ts` matches `/abs/repo/foo/bar.ts` but not `other/foo/bar.ts`.
    if (observedPath.endsWith(`/${targetFile}`)) return true;
    if (targetFile.endsWith(`/${observedPath}`)) return true;

    // Intentionally no basename-only fallback. It used to match any two
    // files sharing the same filename (e.g. every `page.tsx` in a Next.js
    // app, every `fetch.ts`), which silently marked unrelated changed
    // files as "touched" and caused the agent to finalize without
    // inspecting them.
    return false;
}

function extractChangedLineRanges(patch?: string): Array<[number, number]> {
    if (!patch) return [];

    const ranges: Array<[number, number]> = [];

    for (const line of patch.split('\n')) {
        const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (!match) continue;

        const start = parseInt(match[1], 10);
        const count = parseInt(match[2] || '1', 10);
        const end = count > 0 ? start + count - 1 : start;
        ranges.push([start, end]);
    }

    return ranges;
}

function toPositiveNumber(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
