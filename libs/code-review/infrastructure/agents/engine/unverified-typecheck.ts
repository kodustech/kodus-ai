/**
 * #1940 — a type check that did not really check the target must not read as a
 * scoped pass.
 *
 * `checkTypes` runs `npx tsc --noEmit -p <tsconfig>` and keeps only the lines
 * that mention the target. When the project itself cannot be loaded, tsc prints
 * project-level errors instead of diagnostics about source files, so the target
 * filter keeps nothing and the tool answered
 *
 *   No diagnostics matched <file>; omitted unrelated diagnostics outside this
 *   local scope.
 *
 * The finder read that as a clean check and wrote "type-checks cleanly,
 * confirming it exists in the external package" about a symbol that lives in
 * an unfetched submodule (trace `6a5dbd2d`, published as critical). The sandbox
 * makes the state permanent: it never installs dependencies and never fetches
 * submodules (#1939), so any tsconfig referencing a package on disk fails
 * exactly this way.
 *
 * Detection is by SHAPE, not by a list of codes. tsc reports a diagnostic about
 * a source file as `<file>(<line>,<col>): error TSxxxx` (or
 * `<file>:<line>:<col> - error TSxxxx` when pretty is on), so a line is
 * project-level when it carries no location at all — `error TS6053: File '...'
 * not found.` — or when its location is not a source file, as in
 * `tsconfig.json(1,2): error TS1005: '}' expected.`. A closed list cannot cover
 * this: the codes that mark a config or project failure are open ended (TS5014,
 * TS5023, TS6054, TS6059, a JSON syntax error located in a tsconfig, ...), and
 * the generic parser codes also appear on real source files, where a list would
 * fire wrongly.
 *
 * Measured with typescript 5.6.3 locally: these failures do NOT all stop the
 * check. TS6053 (missing `files` entry), TS6054 (unsupported extension),
 * TS18002 (empty `files`) and TS6231 print nothing about any source file, while
 * TS5083 (unreadable `extends`), TS5023 (unknown compiler option) and a JSON
 * error in the config are printed ALONGSIDE real source diagnostics. The caller
 * therefore keeps those diagnostics and adds the caveat rather than replacing
 * them: an output like this one still carries a finding worth reporting.
 */

import path from 'node:path';

/**
 * Extensions tsc checks. Anything else in a diagnostic location is a config or
 * project file, which is what makes a located line project-level.
 */
const SOURCE_FILE_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.vue',
    '.svelte',
]);

/**
 * `file(12,5): error TS2322: ...` and its pretty form `file:12:5 - error ...`.
 * The file group consumes spaces: tsc reports paths verbatim, and a repository
 * can hold a directory with a space in its name, where a non-space group would
 * read a real diagnostic as an unlocated one.
 */
const LOCATED_DIAGNOSTIC =
    /^(?<file>.+?)(?:\(\d+,\d+\)|:\d+:\d+)[:\s-]*error (?<code>TS\d{3,5})\b/;

/** `error TS6053: File '...' not found.` — no location, so nothing about a file. */
const UNLOCATED_DIAGNOSTIC = /^error (?<code>TS\d{3,5})\b/;

/** Exact phrase the agent sees; also what the tests assert on. */
export const UNVERIFIED_TYPES_MARKER =
    '[type checker did NOT check this project — the target was not verified]';

/**
 * The project-level code a single output line reports, or `undefined` when the
 * line is a diagnostic about a source file (or not a diagnostic at all).
 */
function projectLevelCodeOf(line: string): string | undefined {
    const unlocated = UNLOCATED_DIAGNOSTIC.exec(line);
    if (unlocated?.groups?.code) {
        return unlocated.groups.code;
    }

    const located = LOCATED_DIAGNOSTIC.exec(line);
    if (!located?.groups?.code || !located.groups.file) {
        return undefined;
    }

    const ext = path.extname(located.groups.file).toLowerCase();
    return SOURCE_FILE_EXTENSIONS.has(ext) ? undefined : located.groups.code;
}

/**
 * True when the line is itself a project-level report, so a caller can keep it
 * out of a target-scoped answer instead of presenting a config error as a
 * diagnostic about the file under review.
 */
export function isProjectLevelTypeScriptLine(line: string): boolean {
    return projectLevelCodeOf(String(line || '').trim()) !== undefined;
}

/**
 * True when the output carries at least one diagnostic about a source file.
 * The caller pairs this with the compiler's exit status: a non-zero status and
 * no located diagnostic means the compiler never checked anything (it could
 * not be resolved, it crashed), which is a different answer from a real finding.
 */
export function hasLocatedTypeScriptDiagnostic(output: string): boolean {
    return String(output ?? '')
        .split('\n')
        .some((rawLine) => {
            const located = LOCATED_DIAGNOSTIC.exec(rawLine.trim());
            if (!located?.groups?.code || !located.groups.file) {
                return false;
            }

            const ext = path.extname(located.groups.file).toLowerCase();
            return SOURCE_FILE_EXTENSIONS.has(ext);
        });
}

/**
 * The project-level TypeScript error codes present in a compiler output, in
 * first-seen order and deduped. Empty means the output carries no evidence that
 * the compiler failed on the project or its configuration.
 */
export function findProjectLevelTypeScriptErrors(output: string): string[] {
    const found = new Set<string>();

    for (const rawLine of String(output ?? '').split('\n')) {
        const code = projectLevelCodeOf(rawLine.trim());
        if (code) {
            found.add(code);
        }
    }

    return Array.from(found);
}
