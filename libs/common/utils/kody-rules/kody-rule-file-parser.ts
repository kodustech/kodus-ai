import * as yaml from 'js-yaml';

/**
 * Deterministic parser for `.kody/rules/**` markdown files (the structured
 * template documented in "Repository Rules").
 *
 * These files are authored against OUR OWN template (YAML frontmatter +
 * `## Instructions` + Bad/Good examples), so they must be imported
 * verbatim — no LLM conversion. The LLM path (see
 * `KodyRulesSyncService.convertFileToKodyRules`) remains the fallback for
 * free-form sources (CLAUDE.md, .cursorrules, ...) and for `.kody` files
 * that don't parse as the template.
 *
 * Returns `null` when the content doesn't look like the template
 * (no/invalid frontmatter or no title), so callers can fall back to the
 * LLM importer instead of failing the sync.
 */

export interface ParsedKodyRuleFile {
    uuid?: string;
    title: string;
    /** Full markdown body after the frontmatter, verbatim. */
    rule: string;
    /** Comma-joined globs (the storage form the matchers consume). */
    path: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    scope: 'file' | 'pull-request';
    /** `enabled: false` in the frontmatter — caller decides how to persist. */
    enabled: boolean;
    examples: Array<{ snippet: string; isCorrect: boolean }>;
}

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

function normalizeSeverity(
    value: unknown,
): ParsedKodyRuleFile['severity'] | null {
    if (typeof value !== 'string') return null;
    const lowered = value.trim().toLowerCase();
    return (VALID_SEVERITIES as readonly string[]).includes(lowered)
        ? (lowered as ParsedKodyRuleFile['severity'])
        : null;
}

function normalizePath(value: unknown): string | null {
    if (Array.isArray(value)) {
        const globs = value
            .filter((g): g is string => typeof g === 'string')
            .map((g) => g.trim())
            .filter(Boolean);
        return globs.length ? globs.join(',') : null;
    }
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    return null;
}

/**
 * Extracts Bad/Good examples from the markdown body.
 *
 * Recognises headings (any level) whose text contains "bad" or "good"
 * ("### Bad example", "## Good:", "#### bad") and captures every fenced
 * code block until the next heading of the same-or-higher level. Text in
 * between is ignored — only the fenced snippets become examples.
 */
export function extractExamplesFromBody(
    body: string,
): ParsedKodyRuleFile['examples'] {
    const examples: ParsedKodyRuleFile['examples'] = [];
    const lines = body.split(/\r?\n/);

    let currentKind: boolean | null = null; // isCorrect, null = outside
    let currentLevel: number | null = null; // heading level that opened it
    let inFence = false;
    let fenceMarker = '';
    let snippetLines: string[] = [];

    const flushSnippet = () => {
        if (currentKind !== null && snippetLines.length) {
            examples.push({
                snippet: snippetLines.join('\n'),
                isCorrect: currentKind,
            });
        }
        snippetLines = [];
    };

    for (const line of lines) {
        if (inFence) {
            if (line.trim().startsWith(fenceMarker)) {
                inFence = false;
                flushSnippet();
            } else {
                snippetLines.push(line);
            }
            continue;
        }

        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
            const level = heading[1].length;
            const text = heading[2].toLowerCase();
            if (/\bbad\b|\bincorrect\b|\bwrong\b/.test(text)) {
                currentKind = false;
                currentLevel = level;
            } else if (/\bgood\b|\bcorrect\b/.test(text)) {
                currentKind = true;
                currentLevel = level;
            } else if (currentLevel !== null && level <= currentLevel) {
                // Only a heading at the same-or-higher level closes the
                // section — a deeper subheading (H4 "Details" under an H3
                // "Bad example") stays inside it.
                currentKind = null;
                currentLevel = null;
            }
            continue;
        }

        const fence = /^\s*(```+|~~~+)/.exec(line);
        if (fence && currentKind !== null) {
            inFence = true;
            fenceMarker = fence[1];
            snippetLines = [];
        }
    }

    // Unterminated fence at EOF: keep what we captured.
    if (inFence) flushSnippet();

    return examples;
}

export function parseKodyRuleFile(content: string): ParsedKodyRuleFile | null {
    if (!content) return null;

    const match = FRONTMATTER_RE.exec(content);
    if (!match) return null;

    let frontmatter: Record<string, unknown>;
    try {
        const parsed = yaml.load(match[1]);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return null;
        }
        frontmatter = parsed as Record<string, unknown>;
    } catch {
        return null;
    }

    const title =
        typeof frontmatter.title === 'string' ? frontmatter.title.trim() : '';
    if (!title) return null;

    const body = content.slice(match[0].length).trim();
    if (!body) return null;

    // The documented field is `severity_min`; accept `severity` too since
    // it's a natural authoring mistake and the intent is unambiguous.
    const severity =
        normalizeSeverity(frontmatter.severity_min) ??
        normalizeSeverity(frontmatter.severity) ??
        'medium';

    const scope =
        frontmatter.scope === 'pull-request' ? 'pull-request' : 'file';

    const path = normalizePath(frontmatter.path) ?? '**/*';

    const uuid =
        typeof frontmatter.uuid === 'string' && frontmatter.uuid.trim()
            ? frontmatter.uuid.trim()
            : undefined;

    return {
        uuid,
        title,
        rule: body,
        path,
        severity,
        scope,
        enabled: frontmatter.enabled !== false,
        examples: extractExamplesFromBody(body),
    };
}

/**
 * Whether `dirPrefix` (e.g. "rules/") appears as a path-segment prefix:
 * at the start of the path or right after a "/". Plain string scan — no
 * regex — so path length can't degrade matching (CodeQL: polynomial
 * regex on uncontrolled data).
 */
function hasDirSegment(pathLower: string, dirPrefix: string): number {
    if (pathLower.startsWith(dirPrefix)) return dirPrefix.length;
    const idx = pathLower.indexOf('/' + dirPrefix);
    return idx >= 0 ? idx + 1 + dirPrefix.length : -1;
}

/**
 * Whether `filePath` is a structured Kody rule template file (the only
 * sources parsed verbatim): anything under `.kody/rules/`, or a `.md`
 * file under `rules/` — at the repo root or any subdirectory, matching
 * the discovery globs (dot-files like `rules/.md` included, since the
 * globs run with `dot: true`).
 */
export function isKodyRuleTemplateFile(
    filePath: string | null | undefined,
): boolean {
    if (!filePath) return false;
    const lower = filePath.replace(/\\/g, '/').toLowerCase();

    const kodyEnd = hasDirSegment(lower, '.kody/rules/');
    if (kodyEnd >= 0 && lower.length > kodyEnd) return true;

    // `rules/**/*.md` is the second documented template location.
    const rulesEnd = hasDirSegment(lower, 'rules/');
    return rulesEnd >= 0 && lower.length > rulesEnd && lower.endsWith('.md');
}
