/**
 * Pure matching/ordering logic for the Kodus hunk sidebar.
 *
 * Split out of `index.tsx` so it can be unit-tested without a React/OpenTUI
 * runtime — the sidebar's real risk isn't the rendering, it's mapping a Kodus
 * finding onto the right file and hunk. Kept dependency-free (types only) so
 * `tsc` never needs to see it and hunk can import it as a plain helper module.
 */

export type KodusSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface KodusFinding {
    id: string;
    file: string;
    line: number;
    endLine: number;
    severity: KodusSeverity;
    title: string;
    category?: string;
    ruleId?: string;
}

export interface KodusFindings {
    version: 1;
    summary?: string;
    findings: KodusFinding[];
}

/** The subset of `ExtensionDiffFile` this module needs. */
export interface DiffFileLike {
    id: string;
    path: string;
    hunks?: ReadonlyArray<{ index: number; newRange?: [number, number] }>;
}

export const SEVERITY_ORDER: KodusSeverity[] = [
    'critical',
    'error',
    'warning',
    'info',
];

export const SEVERITY_GLYPH: Record<KodusSeverity, string> = {
    critical: '‼',
    error: '✖',
    warning: '⚠',
    info: 'ℹ',
};

/**
 * Coerce whatever severity the sidecar carries into one this pane can render.
 *
 * The CLI normalizes before writing, but the API's raw vocabulary is wider
 * (`high` / `medium` / `low`) and the sidecar is a file on disk — an unknown
 * value must degrade to `info`, not sort ahead of `critical` with an undefined
 * glyph.
 */
export function coerceSeverity(value: unknown): KodusSeverity {
    if (typeof value !== 'string') {
        return 'info';
    }
    const normalized = value.toLowerCase();
    if (normalized === 'critical') {
        return 'critical';
    }
    if (normalized === 'error' || normalized === 'high') {
        return 'error';
    }
    if (normalized === 'warning' || normalized === 'medium') {
        return 'warning';
    }
    return 'info';
}

export function parseFindings(raw: unknown): KodusFindings {
    const empty: KodusFindings = { version: 1, findings: [] };
    if (!raw || typeof raw !== 'object') {
        return empty;
    }
    const candidate = raw as Partial<KodusFindings>;
    if (!Array.isArray(candidate.findings)) {
        return empty;
    }
    return {
        version: 1,
        summary: candidate.summary,
        findings: candidate.findings
            .filter(
                (finding): finding is KodusFinding =>
                    Boolean(finding) &&
                    typeof finding.file === 'string' &&
                    typeof finding.line === 'number',
            )
            .map((finding) => ({
                ...finding,
                severity: coerceSeverity(finding.severity),
            })),
    };
}

/**
 * Order findings the way a reviewer triages them: worst first, then by file and
 * line so one file's findings stay together inside a severity band.
 */
export function orderFindings(findings: KodusFinding[]): KodusFinding[] {
    return [...findings].sort((a, b) => {
        const bySeverity =
            SEVERITY_ORDER.indexOf(a.severity) -
            SEVERITY_ORDER.indexOf(b.severity);
        if (bySeverity !== 0) {
            return bySeverity;
        }
        return a.file.localeCompare(b.file) || a.line - b.line;
    });
}

/**
 * Match a finding's path against the review's files.
 *
 * Both sides are normally repo-relative, but a review scoped to a subdirectory
 * can leave the two spelled differently, so fall back to a path-segment suffix
 * match rather than silently dropping the finding.
 */
export function findFile<T extends DiffFileLike>(
    files: readonly T[],
    findingPath: string,
): T | undefined {
    const exact = files.find((file) => file.path === findingPath);
    if (exact) {
        return exact;
    }
    return files.find(
        (file) =>
            file.path.endsWith(`/${findingPath}`) ||
            findingPath.endsWith(`/${file.path}`),
    );
}

/**
 * The hunk whose new-side span covers the finding, or the nearest one.
 *
 * Kodus reviews whole files while hunk only renders changed spans, so a finding
 * can legitimately land outside every hunk. Landing the reviewer on the closest
 * hunk beats refusing to navigate.
 */
export function findHunkIndex(
    file: DiffFileLike,
    finding: Pick<KodusFinding, 'line'>,
): number | null {
    const hunks = file.hunks ?? [];
    if (hunks.length === 0) {
        return null;
    }

    const covering = hunks.find((hunk) => {
        const range = hunk.newRange;
        return range && finding.line >= range[0] && finding.line <= range[1];
    });
    if (covering) {
        return covering.index;
    }

    let nearest: { index: number; distance: number } | null = null;
    for (const hunk of hunks) {
        const range = hunk.newRange;
        if (!range) {
            continue;
        }
        const distance =
            finding.line < range[0]
                ? range[0] - finding.line
                : finding.line - range[1];
        if (!nearest || distance < nearest.distance) {
            nearest = { index: hunk.index, distance };
        }
    }
    return nearest?.index ?? hunks[0].index;
}

/** `src/very/long/path/file.ts` → `…/path/file.ts` for a narrow pane. */
export function shortenPath(path: string, budget: number): string {
    if (path.length <= budget) {
        return path;
    }
    const segments = path.split('/');
    let out = segments[segments.length - 1] ?? path;
    for (let i = segments.length - 2; i >= 0; i--) {
        const next = `${segments[i]}/${out}`;
        if (next.length + 2 > budget) {
            return `…/${out}`;
        }
        out = next;
    }
    return out;
}

export function countBySeverity(
    findings: readonly KodusFinding[],
): Partial<Record<KodusSeverity, number>> {
    const tally: Partial<Record<KodusSeverity, number>> = {};
    for (const finding of findings) {
        tally[finding.severity] = (tally[finding.severity] ?? 0) + 1;
    }
    return tally;
}

/**
 * Advance the severity-first finding cursor.
 *
 * `-1` means "nothing selected yet". Feeding that through the plain modulo
 * lands on `length - 2` when stepping backwards, so the first `p` used to skip
 * the last finding entirely; anchor each direction to its natural start instead.
 */
export function nextCursor(
    cursor: number,
    delta: number,
    length: number,
): number {
    if (length === 0) {
        return -1;
    }
    if (cursor === -1) {
        return delta > 0 ? 0 : length - 1;
    }
    return (cursor + delta + length) % length;
}
