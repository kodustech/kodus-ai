import { normalizeSeverity } from '../../services/review-normalizer.js';
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
    /**
     * Experimental STML body (hunk >= 0.18, requires `--experimental`).
     * Ignored by older hunks and by sessions without the flag, which fall back
     * to `summary` + `rationale`.
     */
    markup?: string;
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
    const { head } = splitFirstSentence(source);
    // `/cli/review` bypasses the suggestions normalizer, so `high` / `medium` /
    // `low` arrive verbatim and would miss every severity lookup below.
    const severity = normalizeSeverity(issue.severity);
    const glyph = SEVERITY_GLYPH[severity] ?? '';

    // The summary is a *label*, not the note's content: hunk renders it as the
    // note's opening line and STML (when enabled) replaces the body entirely.
    // Capping it used to be the only place the message appeared, which silently
    // dropped the tail of any first sentence longer than the cap — the body
    // below now always carries the full text, so a cut here loses nothing.
    const headline = capHeadline(head, HEADLINE_MAX);
    const summary = glyph ? `${glyph} ${headline}` : headline;

    const attribution = buildAttribution(issue, severity);

    // Plain-text fallback, used when `--experimental` (and therefore STML) is
    // off, or when hunk rejects the markup. Hunk word-wraps this as a single
    // paragraph and ignores `\n\n`, so it reads as prose rather than sections.
    const parts: string[] = [withTrailingPeriod(source)];

    if (advice && advice !== message && advice !== source) {
        parts.push(`Fix: ${withTrailingPeriod(advice)}`);
    }

    if (issue.fix) {
        parts.push(
            `Suggested ${issue.fix.type} (lines ${issue.fix.startLine}-${issue.fix.endLine}): ${issue.fix.newCode.trim()}`,
        );
    }

    parts.push(`— Kody · ${attribution}`);

    return {
        newRange: [start, end],
        summary,
        rationale: parts.join(' '),
        markup: buildMarkup(issue, severity, source, advice, attribution),
    };
}

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildAttribution(issue: ReviewIssue, severity: Severity): string {
    const bits: string[] = [`severity ${SEVERITY_LABEL[severity]}`];
    if (issue.category) {
        bits.push(issue.category);
    }
    // Kody-rule findings carry the rule's UUID, which reads as noise and is
    // already in the rule link the body keeps. Named rule ids still earn a spot.
    if (issue.ruleId && !UUID_RE.test(issue.ruleId)) {
        bits.push(issue.ruleId);
    }
    return bits.join(' · ');
}

const SEVERITY_MARKUP_COLOR: Record<Severity, string> = {
    critical: 'danger',
    error: 'danger',
    warning: 'warning',
    info: 'info',
};

/**
 * STML body for the note (`hunk … --experimental`).
 *
 * The plain-text rationale has to be one wrapped paragraph, which jams the
 * explanation, the fix and any suggested code together — the worst case being a
 * code snippet reflowed as prose. STML lets each of those be its own block, so
 * the reader can see where the explanation ends and the patch begins.
 *
 * Degrades safely: hunk falls back to `summary`/`rationale` when markup is
 * malformed or `--experimental` is absent.
 */
function buildMarkup(
    issue: ReviewIssue,
    severity: Severity,
    body: string,
    advice: string | undefined,
    attribution: string,
): string {
    const color = SEVERITY_MARKUP_COLOR[severity];
    const label = SEVERITY_LABEL[severity];

    const { text: prose, links } = extractMarkdownLinks(body);

    const blocks: string[] = [
        `<text><badge color="${color}">${escapeStml(label)}</badge>${
            issue.category ? ` <dim>${escapeStml(issue.category)}</dim>` : ''
        }</text>`,
        `<p>${escapeStml(prose)}</p>`,
    ];

    if (advice && advice !== body) {
        // The API's `suggestion` is often a patch, sometimes a patch behind a
        // sentence of prose. Reflowing code as a paragraph is what made these
        // notes unreadable; but `code` clips instead of wrapping, so a prose
        // lead-in put there loses its tail. Split the two.
        const { lead, code } = splitAdvice(advice);
        blocks.push('<h3>Fix</h3>');
        if (lead) {
            blocks.push(`<p>${escapeStml(lead)}</p>`);
        }
        if (code) {
            blocks.push(`<code>\n${escapeStml(wrapCodeBlock(code))}\n</code>`);
        }
    }

    if (issue.fix) {
        // `code` is verbatim — it clips instead of wrapping, which is what a
        // patch needs and exactly what the prose fallback cannot do.
        blocks.push(
            `<code title="${escapeStml(
                `${issue.fix.type} · lines ${issue.fix.startLine}-${issue.fix.endLine}`,
            )}">\n${escapeStml(wrapCodeBlock(issue.fix.newCode.trim()))}\n</code>`,
        );
    }

    // URLs go last, out of the prose flow but never dropped: STML's `<a>`
    // renders only the label and discards the href entirely (no OSC 8 either),
    // so a Kody-rule link put there would be unreachable. A dim paragraph keeps
    // it — and `p` wraps long tokens instead of clipping them.
    for (const link of links) {
        // The label already reads inline above, so repeating it only earns its
        // place when several URLs need telling apart.
        const caption =
            links.length > 1
                ? `${escapeStml(link.label.replace(/[.:\s]+$/, ''))}: `
                : '';
        blocks.push(`<p><dim>${caption}${escapeStml(link.url)}</dim></p>`);
    }

    blocks.push(`<text><dim>— Kody · ${escapeStml(attribution)}</dim></text>`);

    return blocks.join('\n');
}

export interface ExtractedLink {
    label: string;
    url: string;
}

/**
 * Pull Markdown links out of a finding and undo Markdown escaping.
 *
 * Kody-rule findings arrive with the rule name as `[label](url)` plus
 * backslash-escaped punctuation, which rendered verbatim in the note: a
 * hundred-character URL wrapped through the middle of a sentence. The label
 * stays inline where it reads naturally; the URL is returned for the caller to
 * place at the end.
 */
export function extractMarkdownLinks(text: string): {
    text: string;
    links: ExtractedLink[];
} {
    const links: ExtractedLink[] = [];

    const withoutLinks = text.replace(
        /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        (_match, label: string, url: string) => {
            const cleanLabel = unescapeMarkdown(label).trim();
            links.push({ label: cleanLabel, url });
            return cleanLabel;
        },
    );

    return { text: unescapeMarkdown(withoutLinks), links };
}

/** `exceções\.` → `exceções` — Markdown escaping has no meaning in a TUI note. */
function unescapeMarkdown(text: string): string {
    return text.replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');
}

/**
 * Split advice into an optional prose lead-in and a verbatim code block.
 *
 * Single-line advice is prose. Multi-line advice is code, unless its first line
 * reads like a sentence introducing the snippet ("…the snippet should read:"),
 * in which case that line is wrapped as prose and the rest kept verbatim.
 */
export function splitAdvice(advice: string): { lead?: string; code?: string } {
    const lines = advice.split('\n');
    const first = lines[0];
    const firstIsCode = /[{}();=]/.test(first) || /^\s/.test(first);

    if (lines.length === 1) {
        return firstIsCode ? { code: advice } : { lead: advice };
    }

    if (firstIsCode) {
        return { code: advice };
    }

    const rest = lines.slice(1).join('\n').replace(/^\n+/, '');
    return {
        lead: first.trim() || undefined,
        code: rest.trim() ? rest : undefined,
    };
}

/**
 * Width to hard-wrap code blocks at.
 *
 * STML `code`/`pre` blocks *clip* long lines instead of wrapping them — text
 * past the pane edge is silently gone, which is the whole failure this note
 * rework exists to fix. Hunk sizes the note from the live session and we spawn
 * it fresh, so there is no width to query; the STML guide's advice is to design
 * for ~56 columns, and the block's border plus padding costs 4 of those.
 */
const CODE_WRAP_FALLBACK = 52;

/**
 * Width to hard-wrap code blocks at.
 *
 * STML `code`/`pre` blocks *clip* long lines instead of wrapping them, so this
 * has to stay under the note's real interior width — and that width cannot be
 * derived from the terminal. Measured by rendering a ruler through the live
 * TUI (terminal columns → usable code columns):
 *
 *     80 → 55    100 → 75    120 → 95    140 → 119
 *    160 → 61    180 → 71    200 → 85    238 → 87    300 → 114
 *
 * It drops at 160 because hunk switches to a split diff, and 238 is narrower
 * than 140 because the sidebar area reappears and takes its share. Layout mode,
 * sidebar visibility, pane count and the user's own pane resizing all feed in,
 * so `process.stdout.columns` predicts none of it — an earlier `columns / 2`
 * estimate clipped at 238. The STML guide's own advice is to design for ~56
 * columns; the only term that reliably tracks anything is the narrow end, where
 * the stack layout gives roughly `columns - 25`.
 *
 * Wrapping early on a wide terminal is cosmetic. Clipping loses the text.
 */
function resolveCodeWrapWidth(): number {
    const columns = process.stdout.columns;
    if (!columns || !Number.isFinite(columns)) {
        return CODE_WRAP_FALLBACK;
    }
    return Math.max(20, Math.min(CODE_WRAP_FALLBACK, columns - 25));
}

export function wrapCodeBlock(
    code: string,
    width = resolveCodeWrapWidth(),
): string {
    return code
        .split('\n')
        .flatMap((line) => {
            if (line.length <= width) {
                return [line];
            }
            const indent = `${line.match(/^\s*/)?.[0] ?? ''}  `;
            const chunks: string[] = [];
            let rest = line;
            let budget = width;
            while (rest.length > budget) {
                chunks.push(rest.slice(0, budget));
                rest = rest.slice(budget);
                budget = Math.max(8, width - indent.length);
                rest = `${indent}${rest}`;
            }
            chunks.push(rest);
            return chunks;
        })
        .join('\n');
}

/** STML is HTML-like, so raw `<`/`&` in a finding would corrupt the body. */
function escapeStml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
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
