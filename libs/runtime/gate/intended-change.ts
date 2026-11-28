import { isDocumentation } from '@libs/runtime/entry-points/no-effect';

import type { LeafChange } from '@libs/runtime/run/leaf-changes';

import type { GateDecision, GateStep } from './gate';
import { isMeasureField } from './gate';
import { HTML_TEXT_FIELD } from './html-fields';

// A difference the PR's own diff spells out is the change the PR means, not a
// regression (planner-eval.md, demo-nextjs#2). The gate reads it
// from the diff's text alone, never from the agent or the PR's description:
// every field that differs must be a literal a changed block of the diff
// removes (main's value) with its counterpart added in the same block (the
// PR's value). A field the diff does not explain keeps the finding, so a
// literal the diff never touches that changes is still a regression.
//
// The diff is the PR author's text, so an explanation must be specific to
// what the probe read, never a coincidence another line of the diff happens
// to share. When in doubt the finding stays a regression:
// - the status is never explained: a route that moves to another status is
//   a regression whatever a line of the diff says;
// - a literal must be distinctive: at least 4 characters with a letter, never
//   a number, a boolean or null (a JSON value that is not a string is never
//   explained);
// - a one-word JSON value is explained only by a line that also names its key;
// - only code counts: a comment (a whole row, the inside of a block comment
//   or a Python docstring, or the part of a row after its comment opens), a
//   test file or a project document (README, changelog) explains nothing;
// - only a file the probed route is declared in counts (the caller's
//   `reachableFiles`): a decoy in a file no route reaches, a doc or a
//   `.txt` explains nothing;
// - a one-word value counts only as a whole string literal on a row that
//   names its key in key position (`role: "x"`, `"role": "x"`,
//   `role = "x"`), never a key or a value inside another string.

/** One difference the diff explains: what main showed, what the PR shows, and the added line that says so. */
export interface IntendedChange {
    /** The compared field (`step.2.value`, `json.status`, `json.userName`). */
    field: string;
    /** Main's literal, as a removed line of the diff holds it (a key name for a renamed field), cut to 200 characters. */
    base: string;
    /** The PR's literal, as the added line holds it, cut to 200 characters. */
    pr: string;
    file: string;
    /** The added line's 1-based line in the PR's file. */
    line: number;
}

export interface IntendedChangeDiffFile {
    path: string;
    patch?: string;
    /** The file after the change, when the product sent it: where a block comment or a docstring opened above the hunk. */
    content?: string;
}

/** A run of removed and added rows between two context rows of a hunk: the rows that replace each other. */
interface ChangeBlock {
    file: string;
    removed: string[];
    added: Array<{ text: string; line: number }>;
}

const VALUE_CHARS = 200;
const clip = (s: string) => (s.length > VALUE_CHARS ? s.slice(0, VALUE_CHARS) : s);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Test code: what it asserts is not what the app answers. */
const TEST_PATH = [/\.(spec|test|e2e)\.[cm]?[jt]sx?$/, /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|fixtures?)\//, /_test\.(go|py)$/, /(^|\/)test_[^/]*\.py$/];
/** Files whose `#` starts a comment (in markup it starts a heading, in CSS a selector). */
const HASH_COMMENT = /(\.(py|rb|sh|bash|zsh|ya?ml|toml|ini|cfg|conf|pl|r|ex|exs|tf|properties)$|(^|\/)Dockerfile[^/]*$)/i;
/** Files whose `--` starts a comment. */
const DASH_COMMENT = /\.(sql|lua|hs)$/i;
/** Files where a leading `*` continues a block comment (in Markdown it is a list item). */
const C_LIKE = /\.([cm]?[jt]sx?|go|java|kt|kts|scala|c|h|cc|cpp|hpp|cs|swift|rs|php|dart|css|scss|less)$/i;

/** Files whose `<!-- -->` is a comment. */
const MARKUP = /\.(html?|vue|svelte|xml|mdx?)$/i;
const PYTHON = /\.py$/i;

type CommentLanguage = 'c' | 'python' | 'hash' | 'dash' | 'markup' | 'plain';
const languageOf = (path: string): CommentLanguage =>
    PYTHON.test(path) ? 'python' : HASH_COMMENT.test(path) ? 'hash' : DASH_COMMENT.test(path) ? 'dash' : C_LIKE.test(path) ? 'c' : MARKUP.test(path) ? 'markup' : 'plain';

/** Where a file's text is between rows: inside a block comment or docstring (its closing token), or a multi-line string (code). */
interface CommentState {
    comment?: string;
    string?: string;
}

/**
 * The code of one row once its comments are taken out, and the state the
 * next row starts in: line and block comments, Python docstrings (a
 * triple-quoted string that opens a statement), strings kept as code. A
 * leading `*` in a C-like file continues a block comment whose opening the
 * hunk does not show.
 */
function codeOfRow(lang: CommentLanguage, text: string, state: CommentState): string {
    if (lang === 'plain') return text;
    let out = '';
    let i = 0;
    if (!state.comment && !state.string && lang === 'c' && /^\s*\*(?!\/)/.test(text)) return '';
    while (i < text.length) {
        if (state.comment) {
            const end = text.indexOf(state.comment, i);
            if (end < 0) return out;
            i = end + state.comment.length;
            state.comment = undefined;
            continue;
        }
        if (state.string) {
            const end = text.indexOf(state.string, i);
            if (end < 0) return out + text.slice(i);
            out += text.slice(i, end + state.string.length);
            i = end + state.string.length;
            state.string = undefined;
            continue;
        }
        const rest = text.slice(i);
        if (lang === 'python' && (rest.startsWith('"""') || rest.startsWith("'''"))) {
            const quote = rest.slice(0, 3);
            // A triple-quoted string that opens the statement is a docstring; after `=`, `(` or `return` it is a value.
            if (!out.trim()) state.comment = quote;
            else {
                out += quote;
                state.string = quote;
            }
            i += 3;
            continue;
        }
        const ch = text[i];
        if (ch === '"' || ch === "'" || (ch === '`' && lang === 'c')) {
            let j = i + 1;
            while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
            out += text.slice(i, Math.min(j + 1, text.length));
            i = j + 1;
            continue;
        }
        if ((lang === 'c' && rest.startsWith('//')) || ((lang === 'python' || lang === 'hash') && ch === '#') || (lang === 'dash' && rest.startsWith('--'))) return out;
        if ((lang === 'c' || lang === 'dash' || lang === 'markup') && rest.startsWith('/*')) {
            state.comment = '*/';
            i += 2;
            continue;
        }
        if ((lang === 'markup' || lang === 'c') && rest.startsWith('<!--')) {
            state.comment = '-->';
            i += 4;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

/** A row with no code left once its comments are out (a JSX comment leaves only its braces). */
const isBlank = (code: string) => /^[\s{}]*$/.test(code);

/** The code of every line of a whole file, 1-based, read from its first line. */
function codeByLine(path: string, content: string): string[] {
    const lang = languageOf(path);
    const state: CommentState = {};
    return ['', ...content.split('\n').map((l) => codeOfRow(lang, l, state))];
}

/** A file whose change cannot be what the app answers: a test or a project document. */
const explainsNothing = (path: string) => isDocumentation(path) || TEST_PATH.some((t) => t.test(path));

/**
 * The change blocks of each file's unified diff, as code: every comment is
 * taken out of each row (a row with nothing left is no row of the block),
 * so a literal in a comment explains nothing. The state of a block comment
 * or docstring is followed through the hunk on each side, and from the
 * file's first line when its content came with the diff. A patch that does
 * not parse adds none; test files and project documents add none.
 */
export function changeBlocksOf(files: readonly IntendedChangeDiffFile[]): ChangeBlock[] {
    const blocks: ChangeBlock[] = [];
    for (const f of files) {
        if (!f.patch || explainsNothing(f.path)) continue;
        const lang = languageOf(f.path);
        const headCode = f.content !== undefined ? codeByLine(f.path, f.content) : undefined;
        let head = 0;
        let inHunk = false;
        let open: ChangeBlock | undefined;
        let onBase: CommentState = {};
        let onHead: CommentState = {};
        const close = () => {
            if (open && open.removed.length && open.added.length) blocks.push(open);
            open = undefined;
        };
        for (const row of f.patch.split('\n')) {
            const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
            if (hunk) {
                close();
                head = Number(hunk[1]) || 0;
                inHunk = true;
                // Nothing says what opened above the hunk but the file itself.
                onBase = {};
                onHead = {};
                continue;
            }
            if (!inHunk || row.startsWith('\\')) continue;
            const text = row.slice(1);
            if (row[0] === '+') {
                const fromPatch = codeOfRow(lang, text, onHead);
                const code = headCode?.[head] ?? fromPatch;
                if (isBlank(code)) {
                    head++;
                    continue;
                }
                open ??= { file: f.path, removed: [], added: [] };
                open.added.push({ text: code, line: head++ });
                continue;
            }
            if (row[0] === '-') {
                const code = codeOfRow(lang, text, onBase);
                if (isBlank(code)) continue;
                open ??= { file: f.path, removed: [], added: [] };
                open.removed.push(code);
                continue;
            }
            codeOfRow(lang, text, onBase);
            codeOfRow(lang, text, onHead);
            close();
            head++;
        }
        close();
    }
    return blocks;
}

/** A row's string literals and the code between them, in order. */
function segmentsOf(code: string): Array<{ string: boolean; text: string }> {
    const out: Array<{ string: boolean; text: string }> = [];
    let i = 0;
    let codeStart = 0;
    while (i < code.length) {
        const ch = code[i];
        if (ch !== '"' && ch !== "'" && ch !== '`') {
            i++;
            continue;
        }
        if (i > codeStart) out.push({ string: false, text: code.slice(codeStart, i) });
        let j = i + 1;
        while (j < code.length && code[j] !== ch) j += code[j] === '\\' ? 2 : 1;
        out.push({ string: true, text: code.slice(i + 1, Math.min(j, code.length)) });
        i = j + 1;
        codeStart = i;
    }
    if (codeStart < code.length) out.push({ string: false, text: code.slice(codeStart) });
    return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether the row names `key` where a key goes: a token of its code
 * followed by `:` or `=` (`role: x`, `role = x`, `.role = x`), or a string
 * that is the key whole followed by `:` or `]` (`"role": x`, `["role"] = x`).
 * Never a key inside another string (`log("role: admin")`).
 */
function namesKey(code: string, key: string): boolean {
    const segments = segmentsOf(code);
    const token = new RegExp(`(?:^|[^A-Za-z0-9_$])${escapeRegExp(key)}\\s*(?:\\?\\s*)?[:=](?!=)`);
    return segments.some((s, i) => (s.string ? norm(s.text) === key && /^\s*[:\]]/.test(segments[i + 1]?.text ?? '') : token.test(s.text)));
}

/** Whether the row holds `literal` as one whole string literal (`"admin"`), never inside a longer one. */
const holdsString = (code: string, literal: string) => segmentsOf(code).some((s) => s.string && norm(s.text) === norm(literal));

const WORD = /[A-Za-z0-9_]/;

/** Whether `line` holds `literal` as a whole token: no word character glued to a word-character edge. */
function holds(line: string, literal: string): boolean {
    const text = norm(line);
    const lit = norm(literal);
    if (!lit) return false;
    for (let at = text.indexOf(lit); at >= 0; at = text.indexOf(lit, at + 1)) {
        const before = text[at - 1];
        const after = text[at + lit.length];
        const gluedBefore = before !== undefined && WORD.test(before) && WORD.test(lit[0]);
        const gluedAfter = after !== undefined && WORD.test(after) && WORD.test(lit[lit.length - 1]);
        if (!gluedBefore && !gluedAfter) return true;
    }
    return false;
}

/** A literal specific enough to point at what the probe read: 4 characters or more, with a letter, not a number, a boolean or null. */
function isDistinctive(literal: string): boolean {
    const t = norm(literal);
    if (t.length < 4 || !/\p{L}/u.test(t)) return false;
    if (/^(true|false|null|nil|none|undefined|nan|infinity)$/i.test(t)) return false;
    return !/^[-+]?(0x[0-9a-f]+|\d[\d_.,]*(e[-+]?\d+)?)$/i.test(t);
}

/** Whether `line` holds `literal` outside every occurrence of `other` (one literal may contain the other). */
const holdsOutside = (line: string, literal: string, other: string) => holds(norm(line).split(norm(other)).join('\u0000'), literal);

/**
 * The added row that replaces `base` with `pr`: one block whose removed rows
 * hold main's literal and whose added rows no longer do, and whose added rows
 * hold the PR's literal that its removed rows did not. With `key`, the added
 * row must also name it, and a removed row holding main's literal too.
 * Literals that are not distinctive are never explained.
 */
function explainPair(base: string, pr: string, blocks: ChangeBlock[], key?: string): { file: string; line: number } | undefined {
    if (!norm(base) || !norm(pr) || norm(base) === norm(pr)) return undefined;
    if (!isDistinctive(base) || !isDistinctive(pr)) return undefined;
    // With a key (a one-word value), the value is a whole string literal on a row that names the key in key position.
    const said = (row: string, literal: string) => (key ? holdsString(row, literal) && namesKey(row, key) : holds(row, literal));
    for (const b of blocks) {
        if (!b.removed.some((r) => said(r, base)) || b.added.some((a) => holdsOutside(a.text, base, pr))) continue;
        if (b.removed.some((r) => holdsOutside(r, pr, base))) continue;
        const added = b.added.find((a) => said(a.text, pr));
        if (added) return { file: b.file, line: added.line };
    }
    return undefined;
}

/** What differs between two texts once their common leading and trailing parts are set aside, by `split`. */
function delta(base: string[], pr: string[]): [string[], string[]] {
    let start = 0;
    while (start < base.length && start < pr.length && norm(base[start]) === norm(pr[start])) start++;
    let end = 0;
    while (end < base.length - start && end < pr.length - start && norm(base[base.length - 1 - end]) === norm(pr[pr.length - 1 - end])) end++;
    return [base.slice(start, base.length - end), pr.slice(start, pr.length - end)];
}

/**
 * A text an expectText or getAttribute step read on each side: the lines
 * that differ, paired one to one, each explained whole or, failing that, by
 * the words that differ inside it.
 */
function explainText(field: string, base: string, pr: string, blocks: ChangeBlock[]): IntendedChange[] | undefined {
    const [b, p] = delta(base.split('\n'), pr.split('\n'));
    if (!b.length || b.length !== p.length) return undefined;
    const out: IntendedChange[] = [];
    for (let i = 0; i < b.length; i++) {
        let pair: [string, string] = [norm(b[i]), norm(p[i])];
        let at = explainPair(pair[0], pair[1], blocks);
        if (!at) {
            const [bw, pw] = delta(pair[0].split(' '), pair[1].split(' '));
            if (!bw.length || !pw.length) return undefined;
            pair = [bw.join(' '), pw.join(' ')];
            at = explainPair(pair[0], pair[1], blocks);
        }
        if (!at) return undefined;
        out.push({ field, base: clip(pair[0]), pr: clip(pair[1]), ...at });
    }
    return out;
}

/** A compared JSON value as the source would write it, when it is a string; undefined for a number, a boolean, null or a value that does not parse. */
function stringLiteralOf(value: string): string | undefined {
    try {
        const v = JSON.parse(value);
        return typeof v === 'string' ? v : undefined;
    } catch {
        return undefined;
    }
}

/** The key a JSON field's value sits under: its last path segment that is not an array index. */
function jsonKeyOf(field: string): string | undefined {
    const parts = field.split('.').slice(1);
    for (let i = parts.length - 1; i >= 0; i--) if (!/^\d+$/.test(parts[i])) return parts[i];
    return undefined;
}

const JSON_FIELD = /^json\./;

/**
 * The JSON fields present on one side only, by the key the diff renamed: the
 * first segment of the path that the other side has no field under. A key
 * renamed with every value under it unchanged, removed and added in one
 * block, is explained; any other one-sided field is not.
 */
function explainRenames(baseOnly: string[], prOnly: string[], base: Record<string, string>, pr: Record<string, string>, blocks: ChangeBlock[]): IntendedChange[] | undefined {
    const prefixes = (fields: Record<string, string>) => {
        const out = new Set<string>();
        for (const f of Object.keys(fields)) {
            const parts = f.split('.');
            for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('.'));
        }
        return out;
    };
    const renamedRoot = (field: string, other: Set<string>) => {
        const parts = field.split('.');
        for (let i = 2; i <= parts.length; i++) if (!other.has(parts.slice(0, i).join('.'))) return parts.slice(0, i).join('.');
        return undefined;
    };
    const onBase = prefixes(base);
    const onPr = prefixes(pr);
    const group = (fields: string[], other: Set<string>) => {
        const roots = new Map<string, string[]>();
        for (const f of fields) {
            const root = renamedRoot(f, other);
            if (!root) return undefined;
            roots.set(root, [...(roots.get(root) ?? []), f]);
        }
        return roots;
    };
    const baseRoots = group(baseOnly, onPr);
    const prRoots = group(prOnly, onBase);
    if (!baseRoots || !prRoots || baseRoots.size !== prRoots.size) return undefined;
    const lastKey = (root: string) => root.slice(root.lastIndexOf('.') + 1);
    const parent = (root: string) => root.slice(0, root.lastIndexOf('.'));
    const out: IntendedChange[] = [];
    const used = new Set<string>();
    for (const [bRoot, bFields] of baseRoots) {
        const match = [...prRoots.keys()].find((pRoot) => {
            if (used.has(pRoot) || parent(pRoot) !== parent(bRoot)) return false;
            const pFields = prRoots.get(pRoot)!;
            if (pFields.length !== bFields.length) return false;
            // The values under the key are unchanged: only its name moved.
            return bFields.every((f) => pr[pRoot + f.slice(bRoot.length)] === base[f]) && !!explainPair(lastKey(bRoot), lastKey(pRoot), blocks);
        });
        if (!match) return undefined;
        used.add(match);
        out.push({ field: bRoot, base: clip(lastKey(bRoot)), pr: clip(lastKey(match)), ...explainPair(lastKey(bRoot), lastKey(match), blocks)! });
    }
    return out;
}

/** The kind of a probe's step, as its single key names it (probe.schema.ts BrowserStepSchema). */
export const browserStepKindsOf = (steps: ReadonlyArray<Record<string, unknown>>): string[] => steps.map((s) => Object.keys(s)[0] ?? '');

/**
 * The step outcomes of a browser probe (`ok`, `fail:<why>` per step): every
 * index where the sides part is an expectText whose read text the diff
 * explains (`ok` against `fail:mismatch`), or a step the runner skipped after
 * it (`skippedAt`). Skipped steps other than screenshots are steps one side
 * never played: `unplayed` lists them, and nothing after the change was
 * compared there.
 */
function explainSteps(base: string, pr: string, explainedValues: Set<number>, kinds: readonly string[] | undefined): { skippedAt: Set<number>; unplayed: number[] } | undefined {
    const b = base.split(',');
    const p = pr.split(',');
    if (b.length !== p.length) return undefined;
    const skippedAt = new Set<number>();
    const unplayed: number[] = [];
    let changedAt: number | undefined;
    for (let i = 0; i < b.length; i++) {
        if (b[i] === p[i]) continue;
        const pair = new Set([b[i], p[i]]);
        if (pair.has('ok') && pair.has('fail:mismatch') && explainedValues.has(i) && (!kinds || kinds[i] === 'expectText')) {
            changedAt ??= i;
            continue;
        }
        if (changedAt !== undefined && i > changedAt && pair.has('fail:skipped') && pair.has('ok')) {
            skippedAt.add(i);
            if (kinds?.[i] !== 'screenshot') unplayed.push(i);
            continue;
        }
        return undefined;
    }
    return { skippedAt, unplayed };
}

/**
 * A `behavior_change` finding whose every differing field the diff explains
 * becomes the PR's intended change: the finding is kept, with `intendedChange`
 * (main's and the PR's literal and the added line), and the caller marks its
 * intent `intended` (it never fails the check, and never reads as success:
 * run-state.ts decideRunVerdict). Explained fields are an expectText or
 * getAttribute value (`step.N.value`), an HTML page's visible text
 * (`html.text`, line by line as a step's value), and a JSON string value or
 * key (`json.*`); the step outcomes follow from an explained value; pixels
 * follow from what the steps read. Anything else (the status, a JSON number,
 * boolean or null, a body digest, an HTML page's markup skeleton, a row
 * count, a network or console count, a value the diff does not change, a
 * literal that is not distinctive) leaves the decision as it was.
 *
 * When the change made one side skip later steps other than a screenshot,
 * those steps never ran there: the probe is `inconclusive`, with the
 * explained change kept, instead of a regression or a settled entry point.
 */
export function decideIntendedChange<D extends GateDecision>(
    decision: D,
    steps: GateStep[],
    opts: {
        diff: readonly IntendedChangeDiffFile[];
        /**
         * The changed files the probed route is declared in (its entry
         * point's file): only their blocks explain. Empty (a probe covering
         * no entry point of the diff, or one reached only through the agent's
         * mapping): nothing is explained.
         */
        reachableFiles: readonly string[];
        browserStepKinds?: readonly string[];
    },
): D {
    if (decision.kind !== 'verdict' || decision.verdict !== 'finding' || decision.findingKind !== 'behavior_change') return decision;
    const observer = steps.filter((s) => s.executor === 'observer' && s.transport === 'ok' && s.vmHealth === 'ok' && !s.timedOut);
    const base = observer.filter((s) => s.side === 'base').sort((a, b) => a.round - b.round)[0];
    const pr = observer.filter((s) => s.side === 'pr').sort((a, b) => a.round - b.round)[0];
    const differing = decision.differingFields;
    if (!base || !pr || !differing.length) return decision;
    const reachable = new Set(opts.reachableFiles);
    const blocks = changeBlocksOf(opts.diff.filter((f) => reachable.has(f.path)));
    if (!blocks.length) return decision;

    const changes: IntendedChange[] = [];
    const explainedValues = new Set<number>();
    const baseOnly: string[] = [];
    const prOnly: string[] = [];
    /** Steps whose value one side has and the other does not: only a step that side skipped explains it. */
    const readOnOneSide: number[] = [];
    for (const field of differing) {
        if (field === 'steps' || isMeasureField(field)) continue;
        const b = base.fields[field];
        const p = pr.fields[field];
        if (JSON_FIELD.test(field) && (b === undefined) !== (p === undefined)) {
            (b === undefined ? prOnly : baseOnly).push(field);
            continue;
        }
        const value = /^step\.(\d{1,2})\.value$/.exec(field);
        if (value && (b === undefined) !== (p === undefined)) {
            readOnOneSide.push(Number(value[1]));
            continue;
        }
        if (b === undefined || p === undefined) return decision;
        if (value || field === HTML_TEXT_FIELD) {
            const explained = explainText(field, b, p, blocks);
            if (!explained) return decision;
            changes.push(...explained);
            if (value) explainedValues.add(Number(value[1]));
            continue;
        }
        // The status is never explained (see the top of this file), nor any field that is not a JSON value.
        if (!JSON_FIELD.test(field)) return decision;
        const bl = stringLiteralOf(b);
        const pl = stringLiteralOf(p);
        if (bl === undefined || pl === undefined) return decision;
        // A one-word value is a common token: the changed line must name the key it sits under.
        const oneWord = !/\s/.test(norm(bl)) || !/\s/.test(norm(pl));
        const key = oneWord ? jsonKeyOf(field) : undefined;
        if (oneWord && !key) return decision;
        const at = explainPair(bl, pl, blocks, key);
        if (!at) return decision;
        changes.push({ field, base: clip(norm(bl)), pr: clip(norm(pl)), ...at });
    }
    if (baseOnly.length || prOnly.length) {
        const renamed = explainRenames(baseOnly, prOnly, base.fields, pr.fields, blocks);
        if (!renamed) return decision;
        changes.push(...renamed);
    }
    if (!changes.length) return decision;

    let skipped: number[] = [];
    if (differing.includes('steps')) {
        const outcome = explainSteps(base.fields.steps ?? '', pr.fields.steps ?? '', explainedValues, opts.browserStepKinds);
        if (!outcome || readOnOneSide.some((i) => !outcome.skippedAt.has(i))) return decision;
        skipped = outcome.unplayed;
    } else if (readOnOneSide.length) return decision;

    const first = changes[0];
    const said = `"${first.base}" on main, "${first.pr}" on the PR, as ${first.file}:${first.line} changes it${changes.length > 1 ? ` (and ${changes.length - 1} more)` : ''}`;
    if (skipped.length) {
        const { findingKind: _kind, ...rest } = decision;
        return {
            ...rest,
            verdict: 'inconclusive',
            reason: `changed as the PR intended (${said}), but one side skipped step${skipped.length > 1 ? 's' : ''} ${skipped.map((i) => i + 1).join(', ')} after it, so nothing after the change was compared`,
            intendedChange: changes,
        } as D;
    }
    return { ...decision, reason: `changed as the PR intended: ${said}`, intendedChange: changes } as D;
}

/**
 * The diff-spelled string rule, applied to one leaf of an object or array
 * field (docs/runtime/monorepo-speed-and-targeting.md section 3): a leaf whose
 * two values are strings is spelled by the diff when one change block of a
 * file the probed route is declared in removes main's literal and adds the
 * PR's, with the same strictness as a whole field (`explainPair`, a one-word
 * value only on a row that names its key). Added, removed and reordered
 * leaves and values that are not strings are never spelled.
 */
export function leafSpelledByDiff(opts: { diff: readonly IntendedChangeDiffFile[]; reachableFiles: readonly string[] }): (leaf: LeafChange) => boolean {
    const reachable = new Set(opts.reachableFiles);
    const blocks = changeBlocksOf(opts.diff.filter((f) => reachable.has(f.path)));
    return (leaf) => {
        if (!blocks.length || leaf.kind !== 'changed' || leaf.base === undefined || leaf.pr === undefined) return false;
        const bl = stringLiteralOf(leaf.base);
        const pl = stringLiteralOf(leaf.pr);
        if (bl === undefined || pl === undefined) return false;
        const oneWord = !/\s/.test(norm(bl)) || !/\s/.test(norm(pl));
        // A leaf path spells indexes in brackets (`details[0].paths[0]`): the key is the last name, indexes taken out.
        const key = oneWord ? leaf.path.replace(/\[\d+\]/g, '').split('.').pop() || undefined : undefined;
        if (oneWord && !key) return false;
        return explainPair(bl, pl, blocks, key) !== undefined;
    };
}
