import type { GateDecision, GateStep } from './gate';
import { isMeasureField } from './gate';
import { HTML_TEXT_FIELD } from './html-fields';

// A difference the PR's own diff spells out is the change the PR means, not a
// regression (planner-eval.md, kr-nextjs#2 Run 04b98118). The gate reads it
// from the diff's text alone, never from the agent or the PR's description:
// every field that differs must be a literal a changed block of the diff
// removes (main's value) with its counterpart added in the same block (the
// PR's value). A field the diff does not explain keeps the finding, so a
// literal the diff never touches that changes is still a regression.

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

/** The change blocks of each file's unified diff; a patch that does not parse adds none. */
export function changeBlocksOf(files: readonly IntendedChangeDiffFile[]): ChangeBlock[] {
    const blocks: ChangeBlock[] = [];
    for (const f of files) {
        if (!f.patch) continue;
        let head = 0;
        let inHunk = false;
        let open: ChangeBlock | undefined;
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
                continue;
            }
            if (!inHunk || row.startsWith('\\')) continue;
            if (row[0] === '+' || row[0] === '-') {
                open ??= { file: f.path, removed: [], added: [] };
                if (row[0] === '+') open.added.push({ text: row.slice(1), line: head++ });
                else open.removed.push(row.slice(1));
                continue;
            }
            close();
            head++;
        }
        close();
    }
    return blocks;
}

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

/** Whether `line` holds `literal` outside every occurrence of `other` (one literal may contain the other). */
const holdsOutside = (line: string, literal: string, other: string) => holds(norm(line).split(norm(other)).join('\u0000'), literal);

/**
 * The added row that replaces `base` with `pr`: one block whose removed rows
 * hold main's literal and whose added rows no longer do, and whose added rows
 * hold the PR's literal that its removed rows did not.
 */
function explainPair(base: string, pr: string, blocks: ChangeBlock[]): { file: string; line: number } | undefined {
    if (!norm(base) || !norm(pr) || norm(base) === norm(pr)) return undefined;
    for (const b of blocks) {
        if (!b.removed.some((r) => holds(r, base)) || b.added.some((a) => holdsOutside(a.text, base, pr))) continue;
        if (b.removed.some((r) => holdsOutside(r, pr, base))) continue;
        const added = b.added.find((a) => holds(a.text, pr));
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

/** A compared value as the source would write it: a JSON string without its quotes, anything else as it is. */
function literalOf(value: string): string {
    try {
        const v = JSON.parse(value);
        return typeof v === 'string' ? v : value;
    } catch {
        return value;
    }
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
 * (`html.text`, line by line as a step's value), a JSON value or key
 * (`json.*`) and the status; the step outcomes follow from an explained
 * value; pixels follow from what the steps read. Anything else (a body
 * digest, an HTML page's markup skeleton, a row count, a network or console
 * count, a value the diff does not change) leaves the decision as it was.
 *
 * When the change made one side skip later steps other than a screenshot,
 * those steps never ran there: the probe is `inconclusive`, with the
 * explained change kept, instead of a regression or a settled entry point.
 */
export function decideIntendedChange<D extends GateDecision>(
    decision: D,
    steps: GateStep[],
    opts: { diff: readonly IntendedChangeDiffFile[]; browserStepKinds?: readonly string[] },
): D {
    if (decision.kind !== 'verdict' || decision.verdict !== 'finding' || decision.findingKind !== 'behavior_change') return decision;
    const observer = steps.filter((s) => s.executor === 'observer' && s.transport === 'ok' && s.vmHealth === 'ok' && !s.timedOut);
    const base = observer.filter((s) => s.side === 'base').sort((a, b) => a.round - b.round)[0];
    const pr = observer.filter((s) => s.side === 'pr').sort((a, b) => a.round - b.round)[0];
    const differing = decision.differingFields;
    if (!base || !pr || !differing.length) return decision;
    const blocks = changeBlocksOf(opts.diff);
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
        if (field !== 'status' && !JSON_FIELD.test(field)) return decision;
        const at = explainPair(literalOf(b), literalOf(p), blocks);
        if (!at) return decision;
        changes.push({ field, base: clip(norm(literalOf(b))), pr: clip(norm(literalOf(p))), ...at });
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
