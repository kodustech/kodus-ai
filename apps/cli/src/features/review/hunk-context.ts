import type {
    ReviewIssue,
    ReviewResult,
    Severity,
} from '../../types/review.js';

/**
 * Schema accepted by `hunk diff --agent-context <file>` — a sidecar of agent
 * notes the TUI renders inline next to the matching hunks. Mirrors the v1
 * shape documented in modem-dev/hunk's docs/agent-workflows.md and the
 * examples/3-agent-review-demo/agent-context.json sample.
 */
export interface HunkAgentContext {
    version: 1;
    summary?: string;
    files: HunkAgentContextFile[];
}

export interface HunkAgentContextFile {
    path: string;
    summary?: string;
    annotations: HunkAgentAnnotation[];
}

export interface HunkAgentAnnotation {
    newRange: [number, number];
    summary: string;
    rationale?: string;
}

const SEVERITY_LABEL: Record<Severity, string> = {
    info: 'info',
    warning: 'warning',
    error: 'error',
    critical: 'critical',
};

/** Compact severity glyphs that scan at a glance in the hunk panel title. */
const SEVERITY_GLYPH: Record<Severity, string> = {
    info: 'ℹ',
    warning: '⚠',
    error: '✖',
    critical: '‼',
};

const HEADLINE_MAX = 140;

export function countHunkAnnotations(context: HunkAgentContext): number {
    return context.files.reduce(
        (sum, file) => sum + file.annotations.length,
        0,
    );
}

export function convertReviewToHunkContext(
    result: ReviewResult,
): HunkAgentContext {
    const filesMap = new Map<string, HunkAgentContextFile>();

    for (const issue of result.issues ?? []) {
        if (!issue.file) {
            continue;
        }

        const annotation = toAnnotation(issue);
        if (!annotation) {
            continue;
        }

        let bucket = filesMap.get(issue.file);
        if (!bucket) {
            bucket = { path: issue.file, annotations: [] };
            filesMap.set(issue.file, bucket);
        }
        bucket.annotations.push(annotation);
    }

    for (const file of filesMap.values()) {
        const count = file.annotations.length;
        file.summary = `${count} ${count === 1 ? 'finding' : 'findings'}`;
        file.annotations.sort(
            (a, b) =>
                a.newRange[0] - b.newRange[0] || a.newRange[1] - b.newRange[1],
        );
    }

    return {
        version: 1,
        summary: buildTopLevelSummary(result),
        files: [...filesMap.values()].sort((a, b) =>
            a.path.localeCompare(b.path),
        ),
    };
}

function toAnnotation(issue: ReviewIssue): HunkAgentAnnotation | null {
    const start = normalizeLine(issue.line);
    if (start === null) {
        return null;
    }
    const end = Math.max(start, normalizeLine(issue.endLine) ?? start);

    const message = issue.message?.trim() ?? '';
    const suggestion = issue.suggestion?.trim() ?? '';
    const recommendation = issue.recommendation?.trim() ?? '';
    const advice = firstNonEmpty(suggestion, recommendation);

    const source =
        firstNonEmpty(message, suggestion, recommendation) ?? 'Kodus finding';
    const { head, rest } = splitFirstSentence(source);
    const headline = capHeadline(head, HEADLINE_MAX);
    const glyph = SEVERITY_GLYPH[issue.severity] ?? '';
    const summary = glyph ? `${glyph} ${headline}` : headline;

    // Hunk's TUI word-wraps the rationale as a single paragraph and ignores
    // `\n\n` separators, so we keep this as one tight piece of prose: body
    // text first, then the fix, then a small attribution tail. Reads naturally
    // even when collapsed onto a single wrapped line.
    const sentences: string[] = [];

    if (rest) {
        sentences.push(rest);
    }

    if (advice && advice !== message && advice !== source) {
        sentences.push(`Fix: ${withTrailingPeriod(advice)}`);
    }

    if (issue.fix) {
        const fixLabel = `Suggested ${issue.fix.type} (lines ${issue.fix.startLine}-${issue.fix.endLine}):`;
        sentences.push(`${fixLabel} ${issue.fix.newCode.trim()}`);
    }

    const attributionBits: string[] = [
        `severity ${SEVERITY_LABEL[issue.severity] ?? issue.severity}`,
    ];
    if (issue.category) {
        attributionBits.push(issue.category);
    }
    if (issue.ruleId) {
        attributionBits.push(issue.ruleId);
    }
    sentences.push(`— Kody · ${attributionBits.join(' · ')}`);

    return {
        newRange: [start, end],
        summary,
        rationale: sentences.join(' '),
    };
}

function withTrailingPeriod(text: string): string {
    return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * Splits a paragraph into a headline (first sentence) and body (the rest).
 * Conservative: only splits on `. `, `! `, or `? ` followed by an uppercase
 * letter, so abbreviations like "e.g." and "i.e." don't trigger a false break.
 */
function splitFirstSentence(text: string): { head: string; rest: string } {
    const trimmed = text.trim();
    if (!trimmed) {
        return { head: '', rest: '' };
    }
    const match = trimmed.match(/^([\s\S]+?[.!?])\s+(?=[A-Z0-9])/);
    if (match) {
        return {
            head: match[1].trim(),
            rest: trimmed.slice(match[0].length).trim(),
        };
    }
    return { head: trimmed, rest: '' };
}

function capHeadline(text: string, max: number): string {
    if (text.length <= max) {
        return text;
    }
    const slice = text.slice(0, max);
    const lastSpace = slice.lastIndexOf(' ');
    const cut =
        lastSpace > Math.floor(max * 0.6) ? slice.slice(0, lastSpace) : slice;
    return `${cut.replace(/[\s,.;:]+$/, '')}…`;
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
            return candidate.trim();
        }
    }
    return undefined;
}

function buildTopLevelSummary(result: ReviewResult): string {
    const total = (result.issues ?? []).length;
    if (total === 0) {
        return result.summary?.trim()
            ? result.summary.trim()
            : 'Kodus review: no findings.';
    }

    const counts: Partial<Record<Severity, number>> = {};
    for (const issue of result.issues) {
        counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
    }

    const breakdown = (['critical', 'error', 'warning', 'info'] as Severity[])
        .filter((s) => counts[s])
        .map((s) => `${counts[s]} ${SEVERITY_LABEL[s]}`)
        .join(', ');

    const headline = `Kodus review: ${total} ${total === 1 ? 'finding' : 'findings'}${
        breakdown ? ` (${breakdown})` : ''
    }.`;

    if (result.summary?.trim()) {
        return `${headline}\n\n${result.summary.trim()}`;
    }
    return headline;
}
