import * as path from 'path';

import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';

export const RULE_FILE_PATTERNS = [
    // Cursor
    '.cursorrules',
    '.cursor/rules/**/*.mdc',

    // GitHub Copilot
    '.github/copilot-instructions.md',
    '.github/instructions/**/*.instructions.md',

    // Agentic
    '.agents.md',
    '.agent.md',

    // Claude
    'CLAUDE.md',
    '.claude/settings.json',

    // Windsurf
    '.windsurfrules',

    // Sourcegraph Cody
    '.sourcegraph/**/*.rule.md',

    // OpenCode
    '.opencode.json',

    // Aider
    '.aider.conf.yml',
    '.aiderignore',

    // Generic / internal
    '.rules/**/*',
    '.kody/rules/**',
    'docs/coding-standards/**/*',
] as const;

export type RuleFilePattern = (typeof RULE_FILE_PATTERNS)[number];

/**
 * Whether `sourcePath` came from an IDE rule file recognised by the auto-sync
 * importer (i.e. it matches one of `RULE_FILE_PATTERNS`, anywhere in the repo).
 *
 * Reason: rules persisted by ingestion all carry a `sourcePath`, but only a
 * subset of those came from the IDE-rule auto-sync flow. Other flows
 * (Onboard, etc.) also set `sourcePath`. Code paths that should only act on
 * IDE-synced rules — e.g. the toggle-off purge in `KodyRulesSyncService` —
 * must use this check, not just `sourcePath != null`, to avoid sweeping up
 * unrelated origins.
 *
 * Patterns are matched at the repo root AND under any subdirectory (e.g. a
 * sourcePath of `applications/sales/.cursorrules` matches the `.cursorrules`
 * pattern via the `**\/` prefix variant), so per-subdir IDE rule imports are
 * recognised the same way as repo-root ones.
 */
export function isIdeRuleSource(
    sourcePath: string | null | undefined,
): boolean {
    if (!sourcePath) return false;
    const patterns: string[] = [
        ...RULE_FILE_PATTERNS,
        ...RULE_FILE_PATTERNS.map((p) => `**/${p}`),
    ];
    return isFileMatchingGlob(sourcePath, patterns);
}

/**
 * Directory segments that act as IDE rule containers, derived from
 * `RULE_FILE_PATTERNS`. Used by code that needs to "strip the IDE part"
 * from a source file path to recover the real repository subdirectory
 * the rule belongs to (see `extractRepoSubdirFromIdeSource`).
 *
 * Derivation: for each pattern, take the longest fixed prefix (the part
 * before any glob wildcard) and grab its directory portion. Root-only
 * patterns like `.cursorrules` or `CLAUDE.md` contribute no marker
 * because they live at the repo root by definition.
 *
 * Sorted longest-first so deeper markers (e.g. `.cursor/rules`) win over
 * their parents (`.cursor`) when both would match the same source path.
 *
 * Single source of truth — adding a new entry to `RULE_FILE_PATTERNS`
 * automatically extends the marker list at module load.
 */
export const IDE_RULE_DIR_MARKERS: ReadonlyArray<string> = (() => {
    const markers = new Set<string>();
    for (const pattern of RULE_FILE_PATTERNS) {
        // Cut the pattern at the first wildcard character to get the
        // longest fixed prefix the matcher requires.
        const fixedPrefix = pattern.split(/[*?[]/)[0];
        // Directory portion of the fixed prefix. If the prefix already
        // ends with "/", strip it; otherwise drop the basename.
        const dir = fixedPrefix.endsWith('/')
            ? fixedPrefix.slice(0, -1)
            : path.posix.dirname(fixedPrefix);
        if (dir && dir !== '.') {
            markers.add(dir);
        }
    }
    return [...markers].sort((a, b) => b.length - a.length);
})();

/**
 * Repository subdirectory a rule was authored for, given the path to the
 * IDE rule source file that produced it. Returns null when the rule
 * lives at the repo root, so callers can keep the rule repo-wide.
 *
 * Strategy: drop any trailing IDE-rule directory marker (see
 * `IDE_RULE_DIR_MARKERS`) from the source's dirname. What remains is
 * the real repo subdir.
 *
 * Examples (with patterns shipped today):
 *   ".cursor/rules/foo.mdc"                 → null
 *   "applications/foo/.cursor/rules/x.mdc"  → "applications/foo"
 *   ".cursorrules"                          → null
 *   "applications/bar/.cursorrules"         → "applications/bar"
 *   "CLAUDE.md"                             → null
 *   "applications/baz/CLAUDE.md"            → "applications/baz"
 */
export function extractRepoSubdirFromIdeSource(
    sourceFilePath: string | null | undefined,
): string | null {
    if (!sourceFilePath) return null;
    const dir = path.posix.dirname(sourceFilePath);
    if (!dir || dir === '.') return null;

    for (const marker of IDE_RULE_DIR_MARKERS) {
        if (dir === marker) return null;
        if (dir.endsWith('/' + marker)) {
            const stripped = dir.slice(0, dir.length - marker.length - 1);
            return stripped || null;
        }
    }

    // Source file uses a root-only pattern (e.g. `.cursorrules`,
    // `CLAUDE.md`) but is placed inside a subdirectory. The subdir IS
    // the dirname.
    return dir;
}

/**
 * Whether `candidatePath` would match an IDE rule file path. Used to
 * reject LLM hallucinations that try to scope a rule against the
 * `.cursor/rules/**` (or similar) directory — i.e. lint the rule
 * source files themselves instead of the actual code.
 */
export function pathMatchesIdeRuleDir(
    candidatePath: string | null | undefined,
): boolean {
    if (!candidatePath) return false;
    // Comma-separated list (KodyRules supports OR-joined globs)
    const globs = candidatePath
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
    if (globs.length === 0) return false;

    return globs.some((glob) => {
        // The glob is "IDE-y" if its fixed prefix is one of the markers
        // (e.g. ".cursor/rules/**" → fixed prefix ".cursor/rules/").
        const fixedPrefix = glob.split(/[*?[]/)[0];
        const dir = fixedPrefix.endsWith('/')
            ? fixedPrefix.slice(0, -1)
            : path.posix.dirname(fixedPrefix);
        if (!dir || dir === '.') return false;
        return IDE_RULE_DIR_MARKERS.some(
            (marker) => dir === marker || dir.endsWith('/' + marker),
        );
    });
}

/**
 * Outcome of validating an LLM-extracted rule path.
 *
 *   accepted-as-is     → path is fine, use it verbatim
 *   accepted-scoped    → path was generic ("**\/*") and got narrowed to
 *                        the source's repo subdir
 *   rejected-ide-path  → LLM tried to lint the rule source files (e.g.
 *                        ".cursor/rules/**\/*"); the path was rebuilt
 *                        from the source location instead
 *   rejected-empty     → LLM returned no path or echoed the source path;
 *                        rebuilt from the source location
 */
export type ValidatedRulePathReason =
    | 'accepted-as-is'
    | 'accepted-scoped'
    | 'rejected-ide-path'
    | 'rejected-empty';

export interface ValidatedRulePath {
    path: string;
    reason: ValidatedRulePathReason;
    /**
     * The original LLM-supplied value (or `undefined`/`null` if missing).
     * Useful for telemetry: which paths required intervention?
     */
    originalLlmPath?: string | null;
}

/**
 * Validate and (when needed) rebuild a rule's `path` glob.
 *
 *   - If the LLM declared the glob (`pathSource === 'declared'`) and the
 *     glob doesn't try to lint the rule source itself, accept verbatim.
 *   - If the path is empty or echoes the source file path, fall back to
 *     `<repo-subdir>/**\/*` (or repo-wide if the source is at the root).
 *   - If the path matches an IDE rule directory ("would lint the rule
 *     source"), do the same fallback rebuild.
 *   - If the path is the generic "**\/*" and `pathSource !== 'declared'`,
 *     scope to the repo subdir derived from the source location.
 *   - Otherwise accept verbatim.
 *
 * Single entry point for path normalisation so the rules can't escape
 * any of these checks. Callers should ALWAYS use this for IDE-sync
 * imports.
 */
export function validateAndScopeIdeRulePath(params: {
    llmPath: string | null | undefined;
    sourceFilePath: string;
    pathSource?: string | null;
}): ValidatedRulePath {
    const { llmPath, sourceFilePath, pathSource } = params;
    // Defensive: if `sourceFilePath` itself looks like a glob (legacy rows
    // in the DB persisted sourcePath as a glob, not a concrete file),
    // fall back to repo-wide rather than producing a Frankenstein scope
    // like "src/**/**/*". The new prompt always sets sourcePath to a
    // concrete file, so this only kicks in for legacy data.
    const sourceLooksLikeGlob = /[*?[]/.test(sourceFilePath || '');
    const subdir = sourceLooksLikeGlob
        ? null
        : extractRepoSubdirFromIdeSource(sourceFilePath);
    const subdirGlob = subdir ? `${subdir}/**/*` : '**/*';

    const isEmpty =
        !llmPath ||
        llmPath.trim() === '' ||
        // LLM echoed the source path back into the rule path, which is
        // the failure mode we saw in production (".cursor/rules/foo.mdc"
        // ending up as path).
        llmPath.trim() === sourceFilePath;

    if (isEmpty) {
        return {
            path: subdirGlob,
            reason: 'rejected-empty',
            originalLlmPath: llmPath,
        };
    }

    if (pathMatchesIdeRuleDir(llmPath)) {
        return {
            path: subdirGlob,
            reason: 'rejected-ide-path',
            originalLlmPath: llmPath,
        };
    }

    // Generic "**\/*" only gets scoped if the LLM didn't explicitly
    // claim it was a declared glob. Respect declared intent.
    if (llmPath === '**/*' && pathSource !== 'declared') {
        if (subdir) {
            return {
                path: subdirGlob,
                reason: 'accepted-scoped',
                originalLlmPath: llmPath,
            };
        }
    }

    return {
        path: llmPath,
        reason: 'accepted-as-is',
        originalLlmPath: llmPath,
    };
}
