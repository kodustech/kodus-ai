import ts from 'typescript';

// Whether a changed file's change can alter what runs, decided by a parser
// and never by a model (docs/runtime/planner-eval.md, fix 1). A file whose
// code reads the same on both sides once comments and layout are set aside
// changes nothing a request can reach: it maps to no route, and a diff made
// only of such files (and documentation) has nothing to test at runtime.
//
// Certain or nothing: a file is judged only when its language has a parser
// here (TypeScript's for JS/TS, small lexers for Go and Python), the head's
// content is given, the base can be rebuilt from it and the patch, and both
// sides parse. Anything else answers undefined and goes the usual way.

export interface ChangedSource {
    path: string;
    patch?: string;
    content?: string;
    /** The path before a rename: a moved file is never judged free of effect. */
    previousPath?: string;
}

/** Files people read and no app serves: what a project's docs change touches. */
const DOC_NAME = /^(readme|changelog|changes|contributing|code_of_conduct|security|authors|maintainers|license|licence|notice|copying)(\.(md|markdown|rst|txt|adoc))?$/i;
/** Directories an app serves or bundles files from: a doc there may be content, not documentation. */
const SERVED_DIR = /(^|\/)(public|static|assets|content|pages|app|src|www|site|templates|views)\//i;
const GITHUB_META = /^\.github\/(ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE|pull_request_template|CODEOWNERS|FUNDING\.yml|SECURITY\.md|CONTRIBUTING\.md|SUPPORT\.md|dependabot\.yml$)/;

/** A documentation file by its name: a README, a changelog, a license, a GitHub template. Never a file under a served directory. */
export function isDocumentation(path: string): boolean {
    if (GITHUB_META.test(path)) return true;
    const name = path.split('/').pop() ?? '';
    return DOC_NAME.test(name) && !SERVED_DIR.test(path);
}

const JS_TS = /\.([cm]?[jt]sx?)$/;
const GO = /\.go$/;
const PY = /\.py$/;

/** The language this module can parse, or undefined. */
export function parsedLanguage(path: string): 'js' | 'go' | 'py' | undefined {
    return JS_TS.test(path) ? 'js' : GO.test(path) ? 'go' : PY.test(path) ? 'py' : undefined;
}

interface PatchRow {
    kind: ' ' | '+' | '-';
    text: string;
    /** 1-based line on the base side (context and removed rows). */
    baseLine?: number;
    /** 1-based line on the head side (context and added rows); a removed row carries the head line it sits before. */
    headLine: number;
}

/** The rows of a unified diff with each side's line numbers, or undefined when it does not parse. */
export function patchRowsOf(patch: string): PatchRow[] | undefined {
    const rows: PatchRow[] = [];
    let base = 0;
    let head = 0;
    let inHunk = false;
    for (const row of patch.split('\n')) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
        if (hunk) {
            base = Number(hunk[1]) || 0;
            head = Number(hunk[2]) || 0;
            inHunk = true;
            continue;
        }
        if (!inHunk || row.startsWith('\\')) continue;
        if (row.startsWith('+++') || row.startsWith('---')) continue;
        const kind = row[0];
        if (kind === '+') rows.push({ kind: '+', text: row.slice(1), headLine: Math.max(1, head++) });
        else if (kind === '-') rows.push({ kind: '-', text: row.slice(1), baseLine: Math.max(1, base++), headLine: Math.max(1, head) });
        else if (kind === ' ' || row === '') rows.push({ kind: ' ', text: row.slice(1), baseLine: Math.max(1, base++), headLine: Math.max(1, head++) });
        else return undefined;
    }
    return rows;
}

/**
 * The base side of a file, rebuilt from its head content and its patch:
 * every context and added row must be the head's line at its place, or the
 * patch and the content disagree and nothing is rebuilt.
 */
export function baseContentOf(patch: string | undefined, head: string | undefined): string | undefined {
    if (patch === undefined || head === undefined) return undefined;
    const rows = patchRowsOf(patch);
    if (!rows) return undefined;
    const lines = head.split('\n');
    const out: string[] = [];
    let cursor = 1;
    // A trailing empty row of the patch text is not a context row.
    const kept = rows.length && rows[rows.length - 1].kind === ' ' && rows[rows.length - 1].text === '' && patch.endsWith('\n') ? rows.slice(0, -1) : rows;
    for (const r of kept) {
        if (r.kind === '-') {
            while (cursor < r.headLine) out.push(lines[cursor++ - 1] ?? '');
            out.push(r.text);
            continue;
        }
        while (cursor < r.headLine) out.push(lines[cursor++ - 1] ?? '');
        if (lines[r.headLine - 1] !== r.text) return undefined;
        if (r.kind === ' ') out.push(r.text);
        cursor = r.headLine + 1;
    }
    while (cursor <= lines.length) out.push(lines[cursor++ - 1]);
    return out.join('\n');
}

export interface CodeShape {
    /** The code as a sequence of tokens and syntax nodes: comments and layout left out. */
    tokens: string[];
    /** 1-based lines that hold code (a token of the program). */
    codeLines: Set<number>;
}

function scriptKind(path: string): ts.ScriptKind {
    if (/\.tsx$/.test(path)) return ts.ScriptKind.TSX;
    if (/\.jsx$/.test(path)) return ts.ScriptKind.JSX;
    if (/\.[cm]?ts$/.test(path)) return ts.ScriptKind.TS;
    return ts.ScriptKind.JS;
}

/** Parses a JS/TS file; undefined when it has a syntax error (nothing certain can be said then). */
export function parseSource(path: string, text: string): ts.SourceFile | undefined {
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
    const diagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
    return diagnostics && diagnostics.length ? undefined : sf;
}

function jsShape(path: string, text: string): CodeShape | undefined {
    const sf = parseSource(path, text);
    if (!sf) return undefined;
    const tokens: string[] = [];
    const codeLines = new Set<number>();
    const visit = (node: ts.Node) => {
        const children = node.getChildren(sf);
        if (!children.length) {
            if (node.kind === ts.SyntaxKind.EndOfFileToken) return;
            tokens.push(`${node.kind}:${node.getText(sf)}`);
            const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            const end = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
            for (let l = start; l <= end; l++) codeLines.add(l);
            return;
        }
        // The node kinds too: `return\nx` and `return x` have the same tokens, not the same tree.
        tokens.push(`(${node.kind}`);
        children.forEach(visit);
        tokens.push(')');
    };
    visit(sf);
    return { tokens, codeLines };
}

/**
 * Go: line and block comments, interpreted, raw and rune literals. A line end
 * after code is a token (Go inserts a semicolon there), so joining or
 * splitting code lines is a change while a comment or blank line is not.
 */
function goShape(text: string): CodeShape | undefined {
    const tokens: string[] = [];
    const codeLines = new Set<number>();
    let line = 1;
    let i = 0;
    let codeOnLine = false;
    const push = (tok: string, from: number, to: number) => {
        tokens.push(tok);
        for (let l = from; l <= to; l++) codeLines.add(l);
        codeOnLine = true;
    };
    while (i < text.length) {
        const c = text[i];
        if (c === '\n') {
            if (codeOnLine) tokens.push('\\n');
            codeOnLine = false;
            line++;
            i++;
        } else if (c === ' ' || c === '\t' || c === '\r') i++;
        else if (c === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (c === '/' && text[i + 1] === '*') {
            const end = text.indexOf('*/', i + 2);
            if (end < 0) return undefined;
            const body = text.slice(i, end + 2);
            const nl = body.split('\n').length - 1;
            // A block comment that spans a line end ends the line as a line end would.
            if (nl && codeOnLine) tokens.push('\\n');
            if (nl) codeOnLine = false;
            line += nl;
            i = end + 2;
        } else if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < text.length && text[j] !== c) {
                if (text[j] === '\n') return undefined;
                j += text[j] === '\\' ? 2 : 1;
            }
            if (j >= text.length) return undefined;
            push(text.slice(i, j + 1), line, line);
            i = j + 1;
        } else if (c === '`') {
            const end = text.indexOf('`', i + 1);
            if (end < 0) return undefined;
            const body = text.slice(i, end + 1);
            const nl = body.split('\n').length - 1;
            push(body, line, line + nl);
            line += nl;
            i = end + 1;
        } else if (/[A-Za-z0-9_.]/.test(c)) {
            let j = i;
            while (j < text.length && /[A-Za-z0-9_.]/.test(text[j])) j++;
            push(text.slice(i, j), line, line);
            i = j;
        } else {
            push(c, line, line);
            i++;
        }
    }
    return { tokens, codeLines };
}

/**
 * Python: `#` comments, string literals with their prefixes (single, triple,
 * raw, f). Indentation is code: each logical line starts with a token of its
 * leading whitespace, and ends with one, so a change of indentation or a
 * joined line is a change while a comment or a blank line is not.
 */
function pyShape(text: string): CodeShape | undefined {
    const tokens: string[] = [];
    const codeLines = new Set<number>();
    let line = 1;
    let i = 0;
    let depth = 0;
    let lineStarted = false;
    let indent = '';
    let atLineStart = true;
    const push = (tok: string, from: number, to: number) => {
        if (!lineStarted && depth === 0) {
            tokens.push(`INDENT:${indent}`);
            lineStarted = true;
        }
        tokens.push(tok);
        for (let l = from; l <= to; l++) codeLines.add(l);
    };
    while (i < text.length) {
        const c = text[i];
        if (atLineStart) {
            let j = i;
            while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
            if (depth === 0 && !lineStarted) indent = text.slice(i, j);
            atLineStart = false;
            i = j;
            continue;
        }
        if (c === '\n') {
            if (lineStarted && depth === 0) {
                tokens.push('NL');
                lineStarted = false;
            }
            line++;
            i++;
            atLineStart = true;
        } else if (c === '\\' && text[i + 1] === '\n') {
            // An explicit continuation: the logical line goes on.
            line++;
            i += 2;
        } else if (c === ' ' || c === '\t' || c === '\r' || c === '\f') i++;
        else if (c === '#') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (c === '"' || c === "'" || (/[rRbBuUfF]/.test(c) && /^[rRbBuUfF]{1,2}["']/.test(text.slice(i, i + 3)))) {
            let j = i;
            while (text[j] !== '"' && text[j] !== "'") j++;
            const q = text[j];
            const triple = text.slice(j, j + 3) === q.repeat(3);
            const close = triple ? q.repeat(3) : q;
            let k = j + close.length;
            while (k < text.length && text.slice(k, k + close.length) !== close) {
                if (!triple && text[k] === '\n') return undefined;
                // A backslash keeps the next character inside the literal, raw or not (a raw string cannot end in one).
                k += text[k] === '\\' ? 2 : 1;
            }
            if (k >= text.length) return undefined;
            const body = text.slice(i, k + close.length);
            const nl = body.split('\n').length - 1;
            push(body, line, line + nl);
            line += nl;
            i = k + close.length;
        } else if (/[A-Za-z0-9_.]/.test(c)) {
            let j = i;
            while (j < text.length && /[A-Za-z0-9_.]/.test(text[j])) j++;
            push(text.slice(i, j), line, line);
            i = j;
        } else {
            if ('([{'.includes(c)) depth++;
            if (')]}'.includes(c)) depth = Math.max(0, depth - 1);
            push(c, line, line);
            i++;
        }
    }
    return { tokens, codeLines };
}

/** The code of a file as its parser sees it, or undefined when its language is not parsed here or it does not parse. */
export function codeShapeOf(path: string, text: string): CodeShape | undefined {
    const lang = parsedLanguage(path);
    if (lang === 'js') return jsShape(path, text);
    if (lang === 'go') return goShape(text);
    if (lang === 'py') return pyShape(text);
    return undefined;
}

const sameTokens = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/** Both sides of a parsed file, or undefined when either cannot be read with certainty. */
function sidesOf(file: ChangedSource): { base: CodeShape; head: CodeShape } | undefined {
    if (!parsedLanguage(file.path) || file.content === undefined || file.patch === undefined) return undefined;
    const baseText = baseContentOf(file.patch, file.content);
    if (baseText === undefined) return undefined;
    const base = codeShapeOf(file.path, baseText);
    const head = codeShapeOf(file.path, file.content);
    return base && head ? { base, head } : undefined;
}

/**
 * Why this file's change cannot alter what runs: it is documentation, or its
 * code is token for token the same on both sides (only comments, blank lines
 * or layout moved). Undefined when it can, or when that is not certain.
 */
export function noEffectReason(file: ChangedSource): string | undefined {
    if (isDocumentation(file.path)) return 'documentation only';
    // A patch with no changed row (a rename, a mode change) says nothing about the code: never judged.
    if (!file.patch || !patchRowsOf(file.patch)?.some((r) => r.kind !== ' ')) return undefined;
    const sides = sidesOf(file);
    if (!sides) return undefined;
    return sameTokens(sides.base.tokens, sides.head.tokens) ? 'only comments, blank lines or layout change' : undefined;
}

/**
 * The head-side lines of the patch's rows that touch code: an added row on a
 * head line that holds code, a removed row on a base line that held code (at
 * the head line it sat before). A row that only adds or removes a comment or
 * a blank line is left out. Undefined when the file cannot be parsed with
 * certainty (the caller then counts every changed row).
 */
export function codeChangedLines(file: ChangedSource): number[] | undefined {
    const sides = sidesOf(file);
    const rows = file.patch ? patchRowsOf(file.patch) : undefined;
    if (!sides || !rows) return undefined;
    const out: number[] = [];
    for (const r of rows) {
        if (r.kind === '+' && sides.head.codeLines.has(r.headLine)) out.push(r.headLine);
        if (r.kind === '-' && r.baseLine !== undefined && sides.base.codeLines.has(r.baseLine)) out.push(r.headLine);
    }
    return [...new Set(out)];
}

/** The path the product appends to a diff it had to cut (extract.ts DIFF_TRUNCATED_MARKER_PATH). */
const TRUNCATED_MARKER = '.kodus-runtime/diff-truncated';

/**
 * Each changed file and why it changes nothing that runs, when every file of
 * the diff does (documentation, or code whose tokens did not change); else
 * undefined. Never for a cut diff, a renamed or deleted file, a recipe file
 * (the Run says what it does with those), a file that is not parsed here, or
 * a patch with no changed row.
 */
export function noRuntimeEffectOf(files: ChangedSource[], opts: { recipe?: Iterable<string>; truncated?: boolean } = {}): { file: string; why: string }[] | undefined {
    if (opts.truncated || !files.length) return undefined;
    const recipe = new Set(opts.recipe ?? []);
    const out: { file: string; why: string }[] = [];
    for (const f of files) {
        if (f.path === TRUNCATED_MARKER || recipe.has(f.path) || f.previousPath) return undefined;
        if (!f.patch || !patchRowsOf(f.patch)?.some((r) => r.kind !== ' ')) return undefined;
        const why = noEffectReason(f);
        if (!why) return undefined;
        out.push({ file: f.path, why });
    }
    return out;
}
