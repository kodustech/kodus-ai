import { posix } from 'path';

import { RUN_PLAN_LIMITS, type RunPlanRequest, unmappedFilesOf } from '@libs/runtime/contracts/run-plan';

import { filePatches } from './file-window';

// Diffs the planner (ADR-069) plans with no model call, because the diff
// itself says there is nothing a targeted probe could reach:
// - only dependency versions move (go.mod, a version pin in package.json).
//   The dependency can change behavior anywhere it is used, which no targeted
//   probe covers; reading the codebase for a route to pin it on is what spent
//   a whole Run's budget (grafana-6, 203.5k tokens) and still guessed a route
//   the diff does not reach.
// - only comments change. Nothing runs differently; an agent asked to plan
//   it guessed a smoke route "via" the file (grafana-3).
// Each such file goes in cannotProve, with why, so the developer knows what
// to check by hand. Anything else in the diff leaves the whole plan to the
// agent.

/** Manifests where any change is a dependency change. */
const ANY_CHANGE = /(^|\/)(go\.mod|requirements[^/]*\.txt|constraints[^/]*\.txt|Pipfile|Gemfile)$/;
/** Manifests that also hold scripts or settings: only lines that pin a version count. */
const PINNED_LINES = /(^|\/)(package\.json|composer\.json|pyproject\.toml|Cargo\.toml)$/;
/** A version or range: `^1.2.3`, `>=1.0, <2`, `~1.2 || 2.x`, `*`. */
// Each repeated version needs a separator that no version holds, so a long run of digits cannot backtrack.
const VERSION = String.raw`(?:[~^<>=!]+\s?)?v?\d[\w.\-+*]*`;
const VALUE = String.raw`["'](?:${VERSION}(?:(?:\s*(?:\|\||,)\s*|\s+)${VERSION})*|\*|latest)["']`;
/** `"name": "^1.2.3",`, `name = "1.2"`, `name = { version = "1.2", features = [...] }`. */
const VERSION_PIN = new RegExp(String.raw`^\s*["']?[@\w./-]+["']?\s*[:=]\s*(?:${VALUE}|\{[^}]*?\bversion\s*=\s*${VALUE}[^}]*\})\s*,?\s*$`);

/**
 * Line comments by language, and a block comment only when it opens and
 * closes on the line (`/* x *\/`). A lone `*\/` or ` * x` is not one: the
 * patch does not show whether it sits inside a comment, and moving a `*\/`
 * comments code in or out (` * b` is also a JS continuation line).
 */
const SLASH_LANGS = /\.(go|[cm]?[jt]sx?|java|kt|kts|scala|swift|cs|rs|php|dart)$/;
const HASH_LANGS = /\.(py|rb|ex|exs|sh|bash)$/;
const SLASH_COMMENT = /^\s*(\/\/|\/\*.*\*\/\s*$)/;
const HASH_COMMENT = /^\s*#/;
/**
 * Comments that change what runs or how it builds: Go directives
 * (`//go:build`, `// +build`, `//go:embed`, `//export`, cgo), a shebang, a
 * Python encoding line, bundler and type-checker comments.
 */
const DIRECTIVE = /^\s*(\/\/\s*(go:|\+build|export\b|line\b|nolint)|\/\/\s*#|#!|#.*coding[:=]|\/\*\s*(webpack|@vite|#__PURE__)|\/\/\s*@ts-|#\s*(type:|noqa|pragma))/;

function changedRows(rows: string[]): string[] {
    return rows.filter((r) => (r.startsWith('+') || r.startsWith('-')) && !r.startsWith('+++') && !r.startsWith('---')).map((r) => r.slice(1));
}

/** Whether this file's patch only moves dependency versions. */
export function isDependencyOnlyChange(path: string, rows: string[] | undefined): boolean {
    if (ANY_CHANGE.test(path)) return true;
    if (!PINNED_LINES.test(path) || !rows) return false;
    const changed = changedRows(rows);
    return changed.length > 0 && changed.every((l) => l.trim() === '' || VERSION_PIN.test(l));
}

/** Whether every line this file's patch adds or removes is blank or a plain comment. */
export function isCommentOnlyChange(path: string, rows: string[] | undefined): boolean {
    const comment = SLASH_LANGS.test(path) ? SLASH_COMMENT : HASH_LANGS.test(path) ? HASH_COMMENT : undefined;
    if (!comment || !rows) return false;
    const changed = changedRows(rows);
    return changed.some((l) => l.trim() !== '') && changed.every((l) => l.trim() === '' || (comment.test(l) && !DIRECTIVE.test(l)));
}

/**
 * The plan of a diff whose only files to plan are manifests with version
 * changes or files with comment changes, or undefined when anything has to
 * be traced.
 */
export function planWithoutModel(request: RunPlanRequest): { probes: []; tests: []; claims: []; cannotProve: string[] } | undefined {
    if (request.entryPoints.some((e) => e.kind !== 'unmapped' && e.kind !== 'dependency_surface')) return undefined;
    const files = unmappedFilesOf(request.entryPoints);
    // A cut diff (the truncation marker) or an unmapped id that is not a file has more to say than its patches.
    if (!files.length || request.entryPoints.filter((e) => e.kind === 'unmapped').length !== files.length) return undefined;
    // A diff at its size limit may have been cut mid-patch: the lines past the cut could be code.
    if (request.diff.length >= RUN_PLAN_LIMITS.diffChars) return undefined;
    const patches = filePatches(request.diff);
    const cannotProve: string[] = [];
    for (const f of files) {
        const rows = patches.get(f);
        if (isDependencyOnlyChange(f, rows)) {
            cannotProve.push(
                `${f}: only dependency versions change (${posix.basename(f)}), with no route of its own; the new versions can change behavior wherever those dependencies are used, which no targeted probe covers: read their release notes and run the test suite`,
            );
        } else if (isCommentOnlyChange(f, rows)) {
            cannotProve.push(`${f}: only comments change, so nothing runs differently and no probe can tell the two sides apart: review the text by hand`);
        } else {
            return undefined;
        }
    }
    return { probes: [], tests: [], claims: [], cannotProve };
}
