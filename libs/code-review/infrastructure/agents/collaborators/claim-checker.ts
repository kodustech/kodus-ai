/**
 * Deterministic claim checker for kody-rules findings (issue #1826).
 *
 * Between the model's word and the published comment, the Kody Rules path has
 * never performed a single check of a finding's merit — the `verify` gate lives
 * in the agentic finder, which this path bypasses. So a shard that sees one
 * file's hunks can assert "this import is unused" about a symbol used twenty
 * lines below the window and the assertion ships (#1724).
 *
 * This module refutes the assertion instead of trusting it. A finding that
 * declares a `claimKind` gets exactly one cheap, deterministic repository check
 * (grep or path existence, never a model call); when the repository contradicts
 * the claim, the finding is dropped. That is the RepoAudit validator pattern at
 * the opposite polarity: a symbolic check adjudicating an LLM alert.
 *
 * Two properties are load-bearing:
 *
 *   1. FAIL CLOSED. "I could not check" is never "I checked and it holds". An
 *      unavailable lookup, a timeout, or a transport error all drop the
 *      finding. Publishing an unverifiable claim is the bug; losing a comment
 *      is the acceptable cost.
 *   2. NO CLAIM, NO CHECK. `none` — which is also where every malformed or
 *      untargeted claim lands — is published unchanged, exactly as today. The
 *      checker is deliberately narrow: it only adjudicates what it can refute.
 *
 * Pure orchestration over an injected `RepoLookup`, so it is unit-testable
 * without a sandbox.
 */
import type { LogArguments } from '@libs/core/log/logger';
import { GREP_NO_MATCHES, toRepoPath } from './repo-lookup';
import type { RepoLookup } from './repo-lookup';
import { SHARD_CONCURRENCY_DEFAULT } from './kody-rules-sharded.judge';
import type { ShardViolation } from './kody-rules-sharded.judge';

export type ClaimKind = 'unused' | 'missing' | 'duplicate' | 'none';

export interface Claim {
    kind: ClaimKind;
    symbol?: string;
    path?: string;
}

/**
 * Structurally what `createLogger()` hands back, so the real `SimpleLogger` is
 * assignable without a cast. The hand-rolled shape this replaced declared
 * `context` optional while `LogArguments` requires it, which made every
 * production call site a type error.
 */
export interface ClaimCheckLogger {
    warn: (entry: LogArguments) => void;
}

export interface ClaimCheckInput {
    violations: ShardViolation[];
    /** The PR's changed files — a `missing` path this PR adds is not missing. */
    changedFiles: Array<{ filename: string }>;
    lookup: RepoLookup;
    /** Bounded to the shard concurrency limit by the caller (KRC-07). */
    concurrency?: number;
    /** Per-check budget; exceeding it means unverifiable, never confirmed. */
    timeoutMs?: number;
    logger?: ClaimCheckLogger;
    /** For the drop-warning's metadata, so a discard is traceable per organization. */
    organizationId?: string;
}

export interface DroppedClaim {
    violation: ShardViolation;
    reason: string;
}

export interface ClaimCheckResult {
    kept: ShardViolation[];
    dropped: DroppedClaim[];
}

/**
 * Per-check time budget. Neither spec nor design fixes a number, so this is the
 * conservative one: a repository grep that has not answered in five seconds is
 * not going to change the verdict, and waiting longer only delays the review.
 */
const DEFAULT_TIMEOUT_MS = 5_000;

/** What `RemoteCommands.grep` returns when ripgrep matched nothing. */
const NO_MATCHES = GREP_NO_MATCHES;

/** Grep answers repo-relative; Azure Repos names files with a leading "/". */
const normalizePath = (p: string): string => toRepoPath(p.trim());

/**
 * Whether a claimed path names a file rather than a directory.
 *
 * `exists` answers over a listing of FILES, so a directory always comes back
 * false. A comment that says "reuse the helper in src/shared" names a real
 * place, and dropping it for that would be the checker inventing a defect.
 * Only the last segment having a dot is treated as a file.
 */
const looksLikeFile = (p: string): boolean =>
    /\.[^./]+$/.test(p.split('/').pop() ?? '');

/** ripgrep is a regex engine; a claimed symbol is a literal. */
const escapeRegex = (s: string): string =>
    s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class UnverifiableClaimError extends Error {}

/**
 * The claim a violation actually carries, after the degradations KRC-09 and
 * KRC-21 require. A kind we do not know, or a kind whose target is absent,
 * names nothing checkable — so it is `none` and the finding is published
 * unchanged rather than dropped for being unparseable.
 */
export function readClaim(violation: ShardViolation): Claim {
    const symbol = violation.claimSymbol?.trim() || undefined;
    const path = violation.claimPath?.trim() || undefined;
    const kind = violation.claimKind;

    if (kind === 'unused' || kind === 'duplicate') {
        return symbol ? { kind, symbol, path } : { kind: 'none' };
    }
    if (kind === 'missing') {
        return path ? { kind, symbol, path } : { kind: 'none' };
    }
    return { kind: 'none' };
}

interface GrepMatch {
    file: string;
    line: number;
    /** The matched line's text ('' when the provider answered without it). */
    text: string;
}

/**
 * Parse `rg --no-heading -n` output (`path:line:content`). A transport failure
 * comes back as an `Error: …` string rather than a throw, and reading that as
 * "no matches" would confirm an `unused` claim with a broken grep — the exact
 * silence this feature exists to remove — so it raises instead.
 */
function parseGrep(output: string): GrepMatch[] {
    const text = output?.trim() ?? '';
    if (!text || text === NO_MATCHES) return [];
    if (text.startsWith('Error:')) {
        throw new UnverifiableClaimError(text);
    }
    const matches: GrepMatch[] = [];
    for (const raw of text.split('\n')) {
        const m = /^(.+?):(\d+):(.*)$/.exec(raw.trim());
        if (m) {
            matches.push({
                file: normalizePath(m[1]),
                line: Number(m[2]),
                text: m[3],
            });
        }
    }
    return matches;
}

/** The lines of each finding of a group: `[start, end]` per sibling. */
type LineRanges = Array<[number, number]>;

/**
 * Whether a grep hit lies outside the finding's own lines. A finding that says
 * a symbol is unused necessarily contains that symbol itself; only an
 * occurrence somewhere ELSE refutes it (and, symmetrically, only an occurrence
 * somewhere else can support a `duplicate` claim). With `ranges`, the lines of
 * each sibling of a group: a hit between two siblings is outside both.
 */
function isElsewhere(
    match: GrepMatch,
    violation: ShardViolation,
    ranges?: LineRanges,
): boolean {
    if (
        ranges &&
        violation.relevantFile &&
        normalizePath(violation.relevantFile) === match.file
    ) {
        return ranges.every(
            ([start, end]) => match.line < start || match.line > end,
        );
    }
    if (
        !violation.relevantFile ||
        normalizePath(violation.relevantFile) !== match.file
    ) {
        return true;
    }
    const start = violation.relevantLinesStart;
    const end = violation.relevantLinesEnd ?? start;
    if (start === undefined || end === undefined) return true;
    return match.line < start || match.line > end;
}

/**
 * A line that brings names in from another module, by the keyword that opens
 * it in the languages the rules review: `import` (JS/TS, Java, Kotlin, Scala,
 * Swift, Go, Dart, Haskell, Elixir), `from x import` (Python), `use` (Rust,
 * PHP, Perl, Elixir), `using` (C#), `alias` (Elixir), `open` (OCaml, F#),
 * `x = require(` (Lua, CommonJS), and stylesheet `@import`/`@use`/`@forward`.
 * A bare `require(…)` binds nothing and is code in Kotlin and Solidity, so it
 * is not one. A re-export (`export … from`) is not
 * one: its users are the files that import it, so it keeps the any-file rule.
 */
const IMPORT_LINE =
    /^\s*(?:import\b(?![.(])|from\s+\S+\s+import\b|(?:const|let|var|local)\s+[^=]+=\s*require\s*\(|use\s+[\p{L}_\\:{]|@(?:import|use|forward)\b)/u;

/** `using` imports only in C# and C++; elsewhere (TS 5.2) it declares a resource. */
const USING_IMPORT =
    /^\s*(?:global\s+)?using\s+(?:static\s+|namespace\s+)?(?:[\p{L}_][\p{L}\p{N}_]*\s*=\s*)?(?:global::)?[\p{L}_][\p{L}\p{N}_.:<>, ]*;\s*$/u;
const USING_FILE =
    /\.(?:cs|cpp|cc|cxx|c\+\+|cppm|ixx|mpp|hpp|hh|hxx|h|ipp|inl|tpp|tcc)$/;
/** Elixir's `alias` imports; Ruby's `alias` renames a method. */
const ELIXIR_FILE = /\.exs?$/;
/** JS and TS, where `{ a: b }` in a `require` destructuring renames `a` to `b`. */
const JS_FILE = /\.[cm]?[jt]sx?$/;
/** `open` imports only in OCaml and F#; elsewhere (Kotlin, Swift) it is a modifier. */
const OPEN_IMPORT = /^\s*open\s+[\p{L}_]/u;
const OPEN_FILE = /\.(?:ml|mli|fs|fsi|fsx)$/;
/** PHP's `use` imports at the top of a file; indented inside a class it uses a trait. */
const PHP_FILE = /\.php$/;
const RUST_FILE = /\.rs$/;

/** Whether a line of `file` is an import statement in that file's language. */
function isImportLine(text: string, file: string): boolean {
    if (USING_FILE.test(file) && USING_IMPORT.test(readStatement(text).code)) {
        return true;
    }
    if (ELIXIR_FILE.test(file) && /^\s*alias\s+[\p{L}_]/u.test(text)) {
        return true;
    }
    if (OPEN_FILE.test(file) && OPEN_IMPORT.test(text)) return true;
    if (!IMPORT_LINE.test(text)) return false;
    return !(PHP_FILE.test(file) && /^\s+use\b/.test(text));
}

/**
 * Imports that bring a module's members into scope without naming them: the
 * file then uses the members, never the name a search looks for. Stylesheet
 * modules, C# `using X.Y;` and `using static`, C++ `using namespace` (not
 * `using std::cout;`, which binds `cout`, nor `using X = Y;`), OCaml/F# `open`,
 * and wildcards
 * (`*`, `._`, `::*`, `from x import *`, Go's `import . "x"`). Rust's
 * `use x::Trait as _;` binds no name and is checked in `bringsNamespace`.
 */
const NAMESPACE_IMPORT =
    /^\s*(?:@(?:import|use|forward)\b|using\s+(?:namespace\s+[\p{L}_][\p{L}\p{N}_.:]*|(?:static\s+)?(?:global::)?[\p{L}_][\p{L}\p{N}_.]*)\s*;|open\s)|(?:\.|::|\\)\s*[*_]\s*(?:[;,)}\]\n]|$)|\bimport\s+\*\s*(?:[;\n]|$)|^\s*(?:import\s+)?\.\s+""/mu;

/**
 * Files whose `import`/`use` brings a whole module in: Elixir, Perl and Swift
 * always, Haskell unless the import is `qualified` or lists its names without
 * `hiding`.
 */
const NAMESPACE_IMPORT_FILE = /\.(?:ex|exs|pl|pm|swift)$/;
const HASKELL_FILE = /\.l?hs$/;

/** Keywords of import statements: never a name the statement binds. */
const IMPORT_KEYWORDS = new Set([
    'import',
    'from',
    'as',
    'use',
    'using',
    'require',
    'require_relative',
    'alias',
    'open',
    'type',
    'typeof',
    'static',
    'qualified',
    'hiding',
    'only',
    'except',
    'const',
    'let',
    'var',
    'local',
    'pub',
    'crate',
    'self',
    'super',
    'mod',
    'export',
    'default',
    'show',
    'hide',
    'deferred',
    'library',
    'package',
    'of',
    'with',
    'in',
    'function',
    'func',
    'namespace',
    'given',
]);

/** The most names one import item is checked by. */
const MAX_BOUND_NAMES = 8;

/**
 * A JSX file's pragma: with the classic runtime every element compiles to a
 * call on it, so the file uses it without ever writing its name. Plain `.js`
 * files carry JSX too (Create React App, Preact).
 */
const JSX_FILE = /\.(?:jsx|tsx|js|mjs|cjs)$/;
const JSX_PRAGMAS = new Set(['React', 'h']);

/** The most lines one import statement is read across. */
const MAX_IMPORT_LINES = 50;

/**
 * A string literal (group 1; an escape may be a line continuation), or a comment: a line comment, a block comment
 * (to the end of the text when it never closes), or `#` after whitespace or a
 * line start (group 2 keeps that whitespace).
 */
const STRING_OR_COMMENT =
    /("(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))|(^|\s)#[^\n]*/gm;

/**
 * A statement read two ways. `prose` drops comments and keeps strings: a
 * stylesheet or Go import names its module in a string. `code` also drops
 * strings: what is left is what the language binds, so a brace, `as` or name
 * inside a string or a comment is not read as part of it.
 */
function readStatement(text: string): { prose: string; code: string } {
    const prose = text.replace(
        STRING_OR_COMMENT,
        (_m, str?: string, lead?: string) => str ?? lead ?? '',
    );
    const code = text.replace(
        STRING_OR_COMMENT,
        (_m, str?: string, lead?: string) => (str ? '""' : (lead ?? '')),
    );
    return { prose, code };
}

/**
 * The statement starting at `lines[start]`: that line, plus the lines until
 * its braces or parentheses close (a multi-line `import {` or `from x import (`),
 * or up to a `;` at depth zero, read in one pass outside strings and comments.
 * `import { a } from './a'; export function g() {` ends at its `;`: the
 * function after it is not part of the import.
 */
function statementAt(lines: string[], start: number): string {
    const text = lines.slice(start, start + MAX_IMPORT_LINES).join('\n');
    let depth = 0;
    let quote = '';
    let comment = '';
    let escaped = false;
    let previous = '\n';
    for (const [i, c] of [...text].entries()) {
        const next = text[i + 1] ?? '';
        if (comment === 'line') {
            if (c === '\n') {
                comment = '';
                if (depth <= 0) return text.slice(0, i);
            }
        } else if (comment === 'block') {
            if (previous === '*' && c === '/') comment = '';
        } else if (quote) {
            if (escaped) escaped = false;
            else if (c === '\\') escaped = true;
            else if (c === quote) quote = '';
        } else if (c === '"' || c === "'" || c === '`') {
            quote = c;
        } else if (c === '/' && next === '/') {
            comment = 'line';
        } else if (c === '/' && next === '*') {
            comment = 'block';
        } else if (c === '#' && /\s/.test(previous)) {
            comment = 'line';
        } else if (c === '{' || c === '(') {
            depth++;
        } else if (c === '}' || c === ')') {
            depth--;
        } else if (c === ';' && depth <= 0) {
            return text.slice(0, i + 1);
        } else if (c === '\n' && depth <= 0) {
            return text.slice(0, i);
        }
        previous = c;
    }
    return text;
}

/**
 * The import statement an `unused` claim is about, if it is about one: read
 * from the repository's own text of the finding's lines first, then from the
 * code the finding cites (a name on its own line of a multi-line import).
 * Only a statement that names the claimed symbol outside a comment counts: a
 * finding about another symbol whose cited code happens to hold an import is
 * not about it. A package's `__init__.py` re-exports what it imports, so its
 * imports keep the any-file rule.
 */
interface ImportStatement {
    text: string;
}

function importStatementOf(
    violation: ShardViolation,
    matches: GrepMatch[],
    symbol: string,
): ImportStatement | undefined {
    const file = normalizePath(violation.relevantFile ?? '');
    const own = matches
        .filter((m) => m.file === file && !isElsewhere(m, violation))
        .map((m) => m.text);
    const cited = (violation.existingCode ?? '').split('\n');
    const statements: ImportStatement[] = [
        ...own
            .filter((line) => isImportLine(line, file))
            .map((text) => ({ text })),
        ...cited.flatMap((line, i) =>
            isImportLine(line, file) ? [{ text: statementAt(cited, i) }] : [],
        ),
    ];
    return statements.find((statement) =>
        hasIdentifier(readStatement(statement.text).prose, symbol),
    );
}

/** The identifier occurs in the text, not as a part of a longer one. */
function hasIdentifier(text: string, symbol: string): boolean {
    return new RegExp(
        `(^|[^\\p{L}\\p{N}_$])${escapeRegex(symbol)}([^\\p{L}\\p{N}_$]|$)`,
        'u',
    ).test(text);
}

/** An identifier, a separator or a bracket of a statement's code. */
const TOKEN = /[\p{L}_$][\p{L}\p{N}_$]*|::|=>|[{}()[\],\n:.\\=]/gu;
const IDENTIFIER = /^[\p{L}_$]/u;
const OPENERS = new Set(['{', '(', '[']);
const CLOSERS = new Set(['}', ')', ']']);

/**
 * The item of an import that holds `symbol`: the piece between commas (or
 * lines, inside brackets) of the innermost bracket group around it, or the
 * statement itself when it has none. An option written `key: value` (Elixir's
 * `as: Name`) belongs to the item before it.
 */
function importItemOf(
    code: string,
    symbol: string,
    file: string,
): string[] | undefined {
    const elixir = ELIXIR_FILE.test(file);
    const stack: string[][][] = [[[]]];
    let found: string[] | undefined;
    for (const token of code.match(TOKEN) ?? []) {
        const group = stack[stack.length - 1];
        const item = group[group.length - 1];
        if (OPENERS.has(token)) {
            stack.push([[]]);
        } else if (CLOSERS.has(token)) {
            if (stack.length > 1) stack.pop();
        } else if (token === ',' || (token === '\n' && stack.length > 1)) {
            group.push([]);
        } else if (
            elixir &&
            token === ':' &&
            item.length === 1 &&
            group.length > 1
        ) {
            group[group.length - 2].push(...item, token);
            group.pop();
        } else if (token !== '\n') {
            item.push(token);
            if (token === symbol && !found) found = item;
        }
    }
    return found;
}

/** What joins the segments of a module path: `a.b`, `a::b`, `A\\B`. */
const PATH_SEPARATORS = new Set(['.', '::', '\\']);
const PYTHON_FILE = /\.pyi?$/;

/** The keywords that rename an import: `x as y` (JS, Python, Kotlin, Rust, Elixir `as:`), `x => y` (Scala). */
const RENAMES = new Set(['as', '=>']);

/**
 * The names an import item binds for `symbol`, and the names it renames.
 * `x as y`, `B => C`, `a::b as c`, `import numpy as np` and Elixir's `as: C`
 * bind only the alias: the source name is not in scope in the importing file,
 * and the file may define its own. Without a rename, the item binds every
 * identifier but the import keywords and a Python `from` module path, and of a
 * module path only its last segment (`import com.acme.Money;` binds `Money`;
 * `com` occurs in the file's own package line, which is not a use) or, in
 * Python, its first (`import os.path` binds `os`).
 */
function boundNames(
    statement: string,
    symbol: string,
    file: string,
): { bound: string[]; renamed: string[] } {
    const item =
        importItemOf(readStatement(statement).code, symbol, file) ?? [];
    const named = (token: string) =>
        IDENTIFIER.test(token) && !IMPORT_KEYWORDS.has(token);
    // `using Json = A.B;`, `import x = require('y')`, `local json = require(…)`:
    // the name before `=` is the binding.
    const assignAt = item.indexOf('=');
    if (assignAt !== -1 && !item.some((token) => RENAMES.has(token))) {
        const alias = item.slice(0, assignAt).filter(named).pop();
        const source = item
            .slice(assignAt + 1)
            .filter(named)
            .pop();
        return {
            bound: alias ? [alias] : [],
            renamed: source && source !== alias ? [source] : [],
        };
    }
    // `const { a: b } = require('m')`: `a` is renamed to `b`.
    const colonAt = item.indexOf(':');
    if (JS_FILE.test(file) && colonAt > 0 && item.length === colonAt + 2) {
        const alias = named(item[colonAt + 1]) ? item[colonAt + 1] : undefined;
        const source = named(item[colonAt - 1]) ? item[colonAt - 1] : undefined;
        return {
            bound: alias ? [alias] : [],
            renamed: source ? [source] : [],
        };
    }
    const renameAt = item.findIndex((token) => RENAMES.has(token));
    if (renameAt !== -1) {
        const alias = item.slice(renameAt + 1).find(named);
        const source = item.slice(0, renameAt).filter(named).pop();
        return {
            bound: alias ? [alias] : [],
            renamed: source ? [source] : [],
        };
    }
    const python = PYTHON_FILE.test(file);
    let inFromPath = false;
    const names = item.filter((token, k) => {
        if (token === 'from') inFromPath = true;
        if (token === 'import') inFromPath = false;
        if (inFromPath || !named(token)) return false;
        const before = PATH_SEPARATORS.has(item[k - 1] ?? '');
        const after = PATH_SEPARATORS.has(item[k + 1] ?? '');
        return python ? !before : !after;
    });
    return { bound: [...new Set(names)], renamed: [] };
}

/** Whether the import brings a module's members in without naming them. */
function bringsNamespace(statement: string, file: string): boolean {
    const { code } = readStatement(statement);
    if (NAMESPACE_IMPORT.test(code)) return true;
    // C#'s `global using` imports for every file of the project.
    if (/^\s*global\s+using\b/.test(code)) return true;
    if (RUST_FILE.test(file) && /\bas\s+_(?![\p{L}\p{N}_$])/u.test(code)) {
        return true;
    }
    if (NAMESPACE_IMPORT_FILE.test(file))
        return /^\s*(?:import|use)\b/.test(code);
    if (HASKELL_FILE.test(file)) {
        return (
            !/\bqualified\b/.test(code) &&
            (!code.includes('(') || /\bhiding\b/.test(code))
        );
    }
    return false;
}

/** Lines read around a finding to find the import it is on. */
const IMPORT_SEARCH_RADIUS = 60;
/** Lines read from the top of a file when the finding names no lines. */
const IMPORT_SEARCH_HEAD = 400;

/** An import statement as the repository has it, with its lines. */
interface RepoImport {
    text: string;
    start: number;
    end: number;
}

/** The last line a read asks for: a model can claim 1..Infinity. */
const MAX_READ_LINE = 1_000_000_000;

/** A finding's lines; an end of `Infinity` runs to the end of the file. */
function linesOf(
    violation: ShardViolation,
): { start: number; end: number } | undefined {
    const start = violation.relevantLinesStart;
    if (typeof start !== 'number' || !Number.isFinite(start)) return undefined;
    const raw = violation.relevantLinesEnd ?? start;
    const end =
        raw === Infinity
            ? MAX_READ_LINE
            : Number.isFinite(raw) && raw >= start
              ? raw
              : start;
    return { start, end };
}

/**
 * The import statements naming `symbol` in the repository's own text of the
 * file, around the findings, in one read: read from the file, not from the
 * code the model cites, so their lines are the file's and a reformatted
 * citation or a finding one line off cannot move them.
 */
async function readImports(
    lookup: ClaimCheckInput['lookup'],
    file: string,
    findings: ShardViolation[],
    symbol: string,
): Promise<RepoImport[]> {
    // A package's `__init__.py` re-exports what it imports: its users are
    // the files importing the package, so it keeps the any-file rule.
    if (file === '__init__.py' || file.endsWith('/__init__.py')) return [];
    const spans = findings
        .map(linesOf)
        .filter((r): r is { start: number; end: number } => !!r);
    const from = spans.length
        ? Math.max(
              1,
              Math.min(...spans.map((r) => r.start)) - IMPORT_SEARCH_RADIUS,
          )
        : 1;
    const to = spans.length
        ? Math.min(
              MAX_READ_LINE,
              Math.max(...spans.map((r) => r.end)) + IMPORT_SEARCH_RADIUS,
          )
        : IMPORT_SEARCH_HEAD;
    let text: string;
    try {
        text = (await lookup.read(file, from, to)) ?? '';
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new UnverifiableClaimError(`could not read ${file}: ${detail}`);
    }
    if (text.startsWith('Error:')) {
        throw new UnverifiableClaimError(`could not read ${file}: ${text}`);
    }
    const lines = text.split('\n');
    return lines.flatMap((line, i): RepoImport[] => {
        if (!isImportLine(line, file)) return [];
        const statement = statementAt(lines, i);
        if (!hasIdentifier(readStatement(statement).prose, symbol)) return [];
        const first = from + i;
        return [
            {
                text: statement,
                start: first,
                end: first + statement.split('\n').length - 1,
            },
        ];
    });
}

/** Of the imports, the one over the finding's lines, else the closest. */
function nearestImport(
    imports: RepoImport[],
    violation: ShardViolation,
): RepoImport | undefined {
    const lines = linesOf(violation);
    const distance = (r: RepoImport): number => {
        if (!lines) return r.start;
        if (r.end < lines.start) return lines.start - r.end;
        if (r.start > lines.end) return r.start - lines.end;
        return 0;
    };
    return imports.reduce<RepoImport | undefined>(
        (best, r) => (!best || distance(r) < distance(best) ? r : best),
        undefined,
    );
}

/**
 * Files whose imports are always used by their name, so a file that never
 * names a bound name does not use the import: JS and TS (not Vue, Svelte or
 * Astro templates), Java, PHP, Python, Go and C#.
 */
const SAME_FILE_RULE_FILE = /\.(?:[cm]?[jt]sx?|java|php|pyi?|go|cs)$/;

/**
 * Whether another file imports `symbol` from this Python module, or reaches it
 * through the module (`api.connect`): the module re-exports it.
 */
function reexported(
    file: string,
    symbol: string,
    matches: GrepMatch[],
): boolean {
    const module =
        file
            .replace(/\.pyi?$/, '')
            .split('/')
            .pop() ?? '';
    if (!module) return false;
    const viaModule = new RegExp(
        `(^|[^\\p{L}\\p{N}_$])${escapeRegex(module)}\\s*\\.\\s*${escapeRegex(symbol)}([^\\p{L}\\p{N}_$]|$)`,
        'u',
    );
    return matches.some(
        (m) =>
            m.file !== file &&
            ((isImportLine(m.text, m.file) && hasIdentifier(m.text, module)) ||
                viaModule.test(m.text)),
    );
}

/** Whether the import's lines meet the finding's. */
function overlaps(real: RepoImport, violation: ShardViolation): boolean {
    const lines = linesOf(violation);
    return !!lines && real.start <= lines.end && real.end >= lines.start;
}

/**
 * The verdict on an unused claim about an import (#1724 QA): only a use in the
 * file that imports it refutes it. Every local import also occurs where it is
 * defined, and other files may import and use the same name: neither makes
 * this import used. Undefined when the claim is not about a name the import
 * binds (a module path, `import f "fmt"`): judge it as main.
 */
async function judgeImport(
    real: RepoImport,
    file: string,
    symbol: string,
    matches: GrepMatch[],
    lookup: ClaimCheckInput['lookup'],
): Promise<string | null | undefined> {
    const shown = real.text.trim().replace(/\s+/g, ' ');
    const onImport = (m: GrepMatch) =>
        m.file === file && m.line >= real.start && m.line <= real.end;
    // The import names the symbol, so a search that reached the file finds
    // it there. None means the search did not cover the file (a hidden or
    // ignored path), and its silence is no evidence of "unused".
    if (!matches.some(onImport)) {
        throw new UnverifiableClaimError(
            `the search did not reach ${file}, so it cannot tell whether "${shown}" is used`,
        );
    }
    if (bringsNamespace(real.text, file)) {
        throw new UnverifiableClaimError(
            `"${shown}" brings a module's members in without naming them, so a search cannot tell whether it is used`,
        );
    }
    if (JSX_FILE.test(file) && JSX_PRAGMAS.has(symbol)) {
        throw new UnverifiableClaimError(
            `"${symbol}" may be used by every JSX element in ${file} without its name, so a search cannot tell whether it is used`,
        );
    }
    const { bound: names, renamed } = boundNames(real.text, symbol, file);
    if (names.length === 0) return undefined;
    if (names.length > MAX_BOUND_NAMES) {
        throw new UnverifiableClaimError(
            `"${shown}" binds more names than the check reads`,
        );
    }
    const others = names.filter((name) => name !== symbol);
    const hits = others.length
        ? [
              ...matches,
              ...parseGrep(
                  await lookup.grep(
                      others.map(escapeRegex).join('|'),
                      '.',
                      `/${globEscape(file)}`,
                  ),
              ),
          ]
        : matches;
    // Anywhere in the file but the import's own lines. Any other line counts,
    // an import-looking one too (`using var`, Kotlin's `require(…)`, a trait
    // `use`): code in some languages, and taking one for an import would
    // publish an import the file uses. On another import line the string is a
    // module path (`'./Button.css'`), so only its code counts.
    const uses = hits.filter((m) => {
        if (m.file !== file || onImport(m)) return false;
        const text =
            m.text && isImportLine(m.text, file)
                ? readStatement(m.text).code
                : m.text;
        return names.some((name) => namesSymbol(text, name));
    });
    const bound =
        names.includes(symbol) && others.length === 0
            ? ''
            : ` (bound as ${names.join(', ')})`;
    const where = [...new Set(uses.map((m) => `${m.file}:${m.line}`))]
        .slice(0, 3)
        .join(', ');
    const used = `claimed "${symbol}" is unused, but this file uses it${bound} at ${where}`;
    if (uses.length) return used;
    // In other languages an import can be used without its name ever
    // appearing in the file (a Rust trait, Kotlin's `by` delegates, Scala
    // implicits, a Vue template's `<foo-bar>`, a header's `using`): a use of
    // a bound name refutes the claim, but no use proves nothing, so the
    // claim keeps main's any-file rule.
    if (!SAME_FILE_RULE_FILE.test(file)) return undefined;
    // A Python module can import a name for others to import from it
    // (`from pkg.api import connect` in another file): it re-exports it.
    if (PYTHON_FILE.test(file) && reexported(file, symbol, matches)) {
        return undefined;
    }
    // The claim names the binding (or the name it renames): nothing in the
    // file uses it. Otherwise the claim is about a module path segment or a
    // Python `from` path, and is judged as main does, by a use in any file.
    return names.includes(symbol) || renamed.includes(symbol)
        ? null
        : undefined;
}

/** A path as a literal ripgrep glob. */
function globEscape(path: string): string {
    return path.replace(/[\\*?[\]{}!]/g, '\\$&');
}

/**
 * The symbol as a whole identifier in the line, not a part of a longer one.
 * The line is read raw: a mention in a comment counts, since `#` and `//`
 * open a comment in some languages and code in others (`#[attr]`, `#field`,
 * Python's `//`). That can keep a true unused import from publishing, never
 * publish one the file uses.
 */
function namesSymbol(text: string, symbol: string): boolean {
    if (!text) return true; // no text to read: count it, as before
    return hasIdentifier(text, symbol);
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new UnverifiableClaimError(
                                `the repository check exceeded its ${timeoutMs}ms budget`,
                            ),
                        ),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Run one claim's check. Resolves to a drop reason, or null to keep.
 * Every failure mode raises `UnverifiableClaimError`, which the caller turns
 * into a drop — never into a confirmation.
 */
async function refute(
    claim: Claim,
    violation: ShardViolation,
    input: ClaimCheckInput,
    owners: ShardViolation[] = [violation],
    group: ShardViolation[] = owners,
    ranges?: LineRanges,
): Promise<string | null> {
    const { lookup, changedFiles } = input;

    if (claim.kind === 'missing') {
        const wanted = normalizePath(claim.path!);
        const addedByThisPr = changedFiles.some(
            (f) => normalizePath(f.filename) === wanted,
        );
        if (addedByThisPr) {
            return `claimed "${wanted}" is missing, but this PR changes it`;
        }
        if (await lookup.exists(claim.path!)) {
            return `claimed "${wanted}" is missing, but it exists in the repository`;
        }
        return null;
    }

    // A non-`missing` claim may ALSO name a path, as supporting evidence:
    // "reuse the helper already in src/shared/slugify.ts". The wire schema asks
    // for `claimPath` on every claim and models fill it in, but only the
    // `missing` branch above ever looked at it — so a fabricated path shipped
    // as long as the SYMBOL was real. Observed: a finding that correctly said
    // `slugify` is duplicated, and sent the developer to a file that does not
    // exist.
    //
    // Only a path that looks like a FILE is checked. "src/shared" is a
    // directory and a perfectly good thing for a comment to name; `exists`
    // lists files, so judging it here would drop true findings.
    if (claim.path && looksLikeFile(claim.path)) {
        const named = normalizePath(claim.path);
        const inThisPr = changedFiles.some(
            (f) => normalizePath(f.filename) === named,
        );
        if (!inThisPr && !(await lookup.exists(claim.path))) {
            return `pointed at "${named}", which does not exist in the repository`;
        }
    }

    const matches = parseGrep(await lookup.grep(escapeRegex(claim.symbol!)));
    const elsewhere = matches.filter((m) => isElsewhere(m, violation, ranges));

    if (claim.kind === 'unused') {
        // An import is judged by the finding that makes the claim and sits on
        // it, not by the group's span: a sibling of the same rule elsewhere
        // in the file would make every use between them "inside the
        // finding". Whether a finding is about an import is read from the
        // repository: an import naming the symbol over the finding's lines,
        // or one the finding cites. A sibling that sits on the import without
        // declaring the claim anchors it only by its citation.
        let found: { file: string; real: RepoImport } | undefined;
        const candidates = [
            ...owners,
            ...group.filter((v) => !owners.includes(v)),
        ].map((own) => ({
            own,
            cited: importStatementOf(own, matches, claim.symbol!),
        }));
        for (const { own, cited } of candidates) {
            // A PR-level finding names no file, so there is no importing file
            // to search: the claim cannot be checked either way.
            if (!own.relevantFile && cited) {
                throw new UnverifiableClaimError(
                    `"${cited.text.trim().replace(/\s+/g, ' ')}" names no file, so a search cannot tell whether the file that imports it uses it`,
                );
            }
        }
        // A finding can be on an import if it cites one, or if it is one of
        // the claim's own findings and has lines to sit on.
        const eligible = candidates.filter(
            ({ own, cited }) =>
                own.relevantFile &&
                (cited || (owners.includes(own) && linesOf(own))),
        );
        if (eligible.length) {
            const file = normalizePath(eligible[0].own.relevantFile!);
            const imports = await readImports(
                lookup,
                file,
                eligible.map((c) => c.own),
                claim.symbol!,
            );
            for (const { own, cited } of eligible) {
                const real = nearestImport(imports, own);
                if (real && (cited || overlaps(real, own))) {
                    found = { file, real };
                    break;
                }
            }
        }
        if (found) {
            const verdict = await judgeImport(
                found.real,
                found.file,
                claim.symbol!,
                matches,
                lookup,
            );
            if (verdict !== undefined) return verdict;
        }
        if (elsewhere.length === 0) return null;
        const where = elsewhere
            .slice(0, 3)
            .map((m) => `${m.file}:${m.line}`)
            .join(', ');
        return `claimed "${claim.symbol}" is unused, but it is used at ${where}`;
    }

    // SPEC_DEVIATION: design.md's check table says a `duplicate` claim drops
    // when there is "no match anywhere". It drops here when there is no match
    // OUTSIDE the finding's own lines.
    // Reason: the flagged code contains the symbol itself, so "anywhere" would
    // let a finding's own line stand in as the pre-existing helper it claims to
    // duplicate — confirming the claim with the claim. `elsewhere` is the same
    // notion `unused` already uses, at the opposite polarity.
    if (elsewhere.length === 0) {
        return `claimed "${claim.symbol}" already exists, but it exists nowhere else in the repository`;
    }
    return null;
}

/**
 * The unit a claim is adjudicated in: one rule, one file, one assertion.
 *
 * The shard prompt asks for "one entry PER violating line PER rule; do not
 * collapse repeats", and the pipeline's `dedupKodyRulesByRuleUuid` folds those
 * repeats back into a SINGLE published comment. Whether a given RUN expands or
 * collapses is sampling variance, not a model trait: kimi-k2.7-code returned
 * one ranged finding in seven observed runs of the same case and eight
 * per-line findings in the eighth.
 *
 * Checking per finding while publishing per group let a refutation land on one
 * sibling while the same assertion shipped on another - in that eighth run the
 * claim was declared on one finding, refuted, and the seven undeclared
 * siblings survived to publish it anyway. Grouping makes the checked unit the
 * published unit, which is the only version of this check that holds whatever
 * model the customer brings and whatever shape a given run returns.
 *
 * The key is (rule, file) and NOTHING ELSE. An earlier version added the
 * finding's own text as a third component, reasoning that one rule may report
 * two different things in one file and a refutation of the first should not
 * silence the second. That reasoning does not survive contact with
 * `dedupKodyRulesByRuleUuid`, which folds every finding sharing a ruleUuid -
 * across files, whatever the wording - into ONE published comment. The
 * distinction the text was protecting is erased before the customer sees it,
 * so the only thing it bought was a split: the model phrases per line, eight
 * findings landed in eight groups, the one declared claim was refuted alone
 * and the seven undeclared siblings published the refuted assertion anyway.
 * Measured on a real E2B run: 1 of 20 negative case-runs leaked exactly that
 * way. The unit stays no finer than what publishing can tell apart.
 */
const groupKeyOf = (violation: ShardViolation): string =>
    [
        violation.ruleUuid ?? '',
        normalizePath(violation.relevantFile ?? ''),
    ].join('::');

/**
 * Whether an undeclared sibling's prose (its summary or suggestion) names the
 * claim's symbol: it repeats the assertion. Its code is not read, unlike
 * `restates`: a sibling about something else on a line that calls the symbol
 * holds a use, not a repetition.
 */
function saysAbout(violation: ShardViolation, claim: Claim): boolean {
    if (!claim.symbol) return false;
    return hasIdentifier(
        `${violation.oneSentenceSummary ?? ''} ${violation.suggestionContent ?? ''}`,
        claim.symbol,
    );
}

/**
 * Does this finding restate the assertion that was refuted?
 *
 * The refuted claim names a target - a symbol, a path, or both. A sibling that
 * is republishing that assertion necessarily names the same target, because
 * that is what the assertion is ABOUT; a sibling about something else in the
 * same file does not. Matching on the target rather than on the sentence is
 * what makes this hold for a model that rewords per line and for a review
 * localized into any language: an identifier and a path survive translation,
 * a sentence does not.
 *
 * Deliberately permissive on the path (the basename counts) and strict on the
 * symbol (delimited, so `slug` does not match `slugify`). When the claim named
 * no target at all there is nothing to match on, and the sibling is kept.
 */
function restates(violation: ShardViolation, claim: Claim): boolean {
    const text = `${violation.oneSentenceSummary ?? ''} ${violation.suggestionContent ?? ''} ${violation.existingCode ?? ''}`;
    if (!text.trim()) return false;

    if (claim.symbol && hasIdentifier(text, claim.symbol)) return true;
    if (claim.path) {
        const normalized = normalizePath(claim.path);
        const base = normalized.split('/').filter(Boolean).pop() ?? '';
        if (normalized && text.includes(normalized)) return true;
        if (base && text.includes(base)) return true;
    }
    return false;
}

/** Identity of a claim, so one repository check serves every finding making it. */
const claimKeyOf = (claim: Claim): string =>
    `${claim.kind}::${claim.symbol ?? ''}::${normalizePath(claim.path ?? '')}`;

/**
 * The group's own lines, as one span. `refute` excludes a finding's own lines
 * when deciding whether a symbol occurs "elsewhere"; with siblings, the whole
 * group is the finding, so the span is their union. For a lone finding this is
 * its own range and the behaviour is byte-identical to before.
 */
function spanOf(group: ShardViolation[]): ShardViolation {
    const starts = group
        .map((v) => v.relevantLinesStart)
        .filter((n): n is number => typeof n === 'number');
    const ends = group
        .map((v) => v.relevantLinesEnd ?? v.relevantLinesStart)
        .filter((n): n is number => typeof n === 'number');
    return {
        ...group[0],
        relevantLinesStart: starts.length ? Math.min(...starts) : undefined,
        relevantLinesEnd: ends.length ? Math.max(...ends) : undefined,
    };
}

/**
 * The lines of each sibling of a group, to judge "elsewhere" by instead of the
 * span's min..max: a sibling further down must not hide the uses between them.
 * Undefined unless every sibling carries its lines, so the span still decides.
 */
function rangesOf(group: ShardViolation[]): LineRanges | undefined {
    if (group.length === 0) return undefined;
    const ranges = group.flatMap((v): LineRanges => {
        const start = v.relevantLinesStart;
        return typeof start === 'number'
            ? [[start, v.relevantLinesEnd ?? start]]
            : [];
    });
    return ranges.length === group.length ? ranges : undefined;
}

/**
 * Check every violation's claim against the repository and split the batch into
 * what may be published and what the repository refuted (or left unverifiable).
 *
 * Findings are adjudicated in (rule, file, assertion) groups. A finding that declares its
 * own claim is judged by that claim's verdict; a finding that declares nothing
 * inherits a refutation from any sibling, because the group ships as one
 * comment and an undeclared sibling would otherwise carry an assertion the
 * repository already refuted. A group where nobody declares anything is still
 * not checked at all - "no claim, no check" is unchanged.
 */
export async function checkClaims(
    input: ClaimCheckInput,
): Promise<ClaimCheckResult> {
    const { violations, lookup, logger, organizationId } = input;
    const concurrency = input.concurrency ?? SHARD_CONCURRENCY_DEFAULT;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const groups = new Map<string, ShardViolation[]>();
    for (const violation of violations) {
        const key = groupKeyOf(violation);
        const group = groups.get(key);
        if (group) {
            group.push(violation);
        } else {
            groups.set(key, [violation]);
        }
    }

    // One repository check per DISTINCT claim per group, not per finding: eight
    // findings making one assertion cost one grep, not eight.
    const jobs: Array<{
        groupKey: string;
        claimKey: string;
        claim: Claim;
        span: ShardViolation;
        owners: ShardViolation[];
        group: ShardViolation[];
        ranges?: LineRanges;
    }> = [];
    for (const [groupKey, group] of groups) {
        const span = spanOf(group);
        const seen = new Set<string>();
        const claims = group.map((violation) => {
            const claim = readClaim(violation);
            return {
                violation,
                claim,
                key: claim.kind === 'none' ? '' : claimKeyOf(claim),
            };
        });
        const byKey = new Map<string, ShardViolation[]>();
        for (const c of claims) {
            byKey.set(c.key, [...(byKey.get(c.key) ?? []), c.violation]);
        }
        for (const { claim, key: claimKey } of claims) {
            if (claim.kind === 'none') {
                continue;
            }
            if (seen.has(claimKey)) {
                continue;
            }
            seen.add(claimKey);
            jobs.push({
                groupKey,
                claimKey,
                claim,
                span,
                owners: byKey.get(claimKey) ?? [],
                group,
                // An unused claim is refuted by a use anywhere but the
                // findings that make or restate it: a sibling about something
                // else, or the lines between siblings, can hold the only use.
                // A duplicate claim keeps the group's span, which a call of
                // the new function inside it must not count as the helper.
                // Siblings making a claim on the same symbol under another key
                // (with a path, or another kind) state it too.
                ranges:
                    claim.kind === 'unused'
                        ? rangesOf(
                              claims
                                  .filter(
                                      (c) =>
                                          c.key === claimKey ||
                                          (c.claim.kind !== 'none' &&
                                              c.claim.symbol ===
                                                  claim.symbol) ||
                                          (c.claim.kind === 'none' &&
                                              saysAbout(c.violation, claim)),
                                  )
                                  .map((c) => c.violation),
                          )
                        : undefined,
            });
        }
    }

    const verdicts = await mapLimit(
        jobs,
        concurrency,
        async ({
            claim,
            span,
            owners,
            group,
            ranges,
        }): Promise<string | null> => {
            if (!lookup.available) {
                return `unverifiable: repository lookup unavailable (${lookup.unavailableReason})`;
            }

            try {
                return await withTimeout(
                    refute(claim, span, input, owners, group, ranges),
                    timeoutMs,
                );
            } catch (err) {
                // Includes RepoLookupUnavailableError: the lookup can go
                // unavailable mid-review (its own probe disables it), and the
                // throw must stop this finding, not the whole shard's result.
                const detail = err instanceof Error ? err.message : String(err);
                logger?.warn({
                    message: `[claim-checker] could not verify a ${claim.kind} claim — dropping the finding: ${detail}`,
                    context: 'claim-checker',
                    metadata: {
                        ruleUuid: span.ruleUuid,
                        filename: span.relevantFile,
                        claimKind: claim.kind,
                        organizationId,
                    },
                });
                return `unverifiable: ${detail}`;
            }
        },
    );

    /** Drop reason per claim, and the first refuted claim seen in each group. */
    const byClaim = new Map<string, string>();
    const byGroup = new Map<string, { reason: string; claim: Claim }>();
    jobs.forEach((job, i) => {
        const reason = verdicts[i];
        if (!reason) {
            return;
        }
        byClaim.set(`${job.groupKey}::${job.claimKey}`, reason);
        if (!byGroup.has(job.groupKey)) {
            byGroup.set(job.groupKey, { reason, claim: job.claim });
        }
    });

    const kept: ShardViolation[] = [];
    const dropped: DroppedClaim[] = [];
    for (const violation of violations) {
        const groupKey = groupKeyOf(violation);
        const claim = readClaim(violation);
        let reason: string | undefined;
        if (claim.kind === 'none') {
            // A finding that asserts nothing is dropped only when it is
            // RESTATING a sibling's refuted assertion. Two findings of one rule
            // in one file may be about genuinely different things, and killing
            // the second because the first was wrong would trade a false
            // positive for a false negative.
            //
            // What separates the two is not prose - the model rewords per line,
            // and a customer's output may not even be in English - but whether
            // the finding names the thing the refutation was about. That target
            // is an identifier or a path: code, not language.
            const refuted = byGroup.get(groupKey);
            if (refuted && restates(violation, refuted.claim)) {
                reason = refuted.reason;
            }
        } else {
            reason = byClaim.get(`${groupKey}::${claimKeyOf(claim)}`);
        }
        if (reason) {
            dropped.push({ violation, reason });
        } else {
            kept.push(violation);
        }
    }
    return { kept, dropped };
}

/**
 * Same bounded-concurrency walk the sharded judge uses (kept local: importing
 * a value from the judge would close a require cycle, since the judge's own
 * types are imported above).
 */
async function mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const out = new Array<R>(items.length);
    let i = 0;
    await Promise.all(
        Array.from(
            { length: Math.min(Math.max(1, limit), items.length || 1) },
            async () => {
                while (i < items.length) {
                    const idx = i++;
                    out[idx] = await fn(items[idx]);
                }
            },
        ),
    );
    return out;
}
