import { normalizeSeverity } from '../../services/review-normalizer.js';
import type {
    ReviewIssue,
    ReviewResult,
    Severity,
} from '../../types/review.js';

/**
 * Structured sidecar consumed by the bundled Kodus hunk extension
 * (`hunk-extension/kodus`).
 *
 * This is deliberately separate from the `--agent-context` payload: that one is
 * hunk's own inline-note schema and flattens severity down to a glyph inside a
 * prose string. The sidebar needs the fields back as data so it can group by
 * severity, count, and jump. Written to a tempfile and handed to the extension
 * through `KODUS_HUNK_FINDINGS`.
 */
export interface KodusHunkFindings {
    version: 1;
    summary?: string;
    findings: KodusHunkFinding[];
}

export interface KodusHunkFinding {
    id: string;
    file: string;
    /** 1-based start line on the new side of the diff. */
    line: number;
    /** Inclusive end line; equal to `line` for single-line findings. */
    endLine: number;
    severity: Severity;
    title: string;
    category?: string;
    ruleId?: string;
}

const TITLE_MAX = 200;

export function convertReviewToHunkFindings(
    result: ReviewResult,
): KodusHunkFindings {
    const findings: KodusHunkFinding[] = [];

    for (const [index, issue] of (result.issues ?? []).entries()) {
        const finding = toFinding(issue, index);
        if (finding) {
            findings.push(finding);
        }
    }

    return {
        version: 1,
        summary: result.summary?.trim() || undefined,
        findings,
    };
}

function toFinding(issue: ReviewIssue, index: number): KodusHunkFinding | null {
    if (!issue.file) {
        return null;
    }

    const line = normalizeLine(issue.line);
    if (line === null) {
        return null;
    }
    const endLine = Math.max(line, normalizeLine(issue.endLine) ?? line);

    const title = firstNonEmpty(
        issue.message,
        issue.suggestion,
        issue.recommendation,
    );

    return {
        id: `kodus-${index}`,
        file: issue.file,
        line,
        endLine,
        // `/cli/review` is *not* run through the suggestions normalizer, so the
        // API's `high` / `medium` / `low` reach us verbatim despite the
        // `Severity` type. Left unmapped they'd sort ahead of `critical` and
        // render an undefined glyph in the sidebar.
        severity: normalizeSeverity(issue.severity),
        title: truncate(title ?? 'Kodus finding', TITLE_MAX),
        category: issue.category || undefined,
        ruleId: issue.ruleId || undefined,
    };
}

function normalizeLine(value: number | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    return Math.floor(value);
}

function firstNonEmpty(
    ...candidates: Array<string | undefined>
): string | undefined {
    for (const candidate of candidates) {
        if (candidate && candidate.trim().length > 0) {
            return candidate.trim().replace(/\s+/g, ' ');
        }
    }
    return undefined;
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
