/**
 * Coding-agent instructions (CLAUDE.md, AGENTS.md, .cursor/rules, Copilot
 * instructions, ...) as review context.
 *
 * These files tell coding agents how the team works. They are not review
 * policy, so they never become Kody Rules. When a repository opts in
 * (`repoInstructionsEnabled`), the generalist gets an index of the ones that
 * govern the changed files, reads them through readRepoInstruction, and may
 * report a `repo_instruction` finding that quotes the instruction a change
 * breaks.
 *
 * Selection and fetching are done before the agent loop, from the target
 * branch, so the tool works without a sandbox, never reads the PR's own edits,
 * and the evals can replay it.
 */
import * as yaml from 'js-yaml';

import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import {
    extractRepoSubdirFromIdeSource,
    isAgentInstructionProseFile,
    splitRulePathGlobs,
} from '@libs/common/utils/kody-rules/file-patterns';

export const REPO_INSTRUCTIONS_LIMITS = {
    maxFiles: 8,
    maxBytesPerFile: 24_000,
    maxTotalBytes: 64_000,
    /** Below this, a file that would overflow the total is dropped, not cut. */
    minUsefulBytes: 1_000,
    /** Paths listed (not inlined) so the agent knows what else exists. */
    maxOtherFiles: 30,
    /** Pointers followed per file (`AI-AGENTS.md`, `@docs/guide.md`). */
    maxPointersPerFile: 10,
} as const;

export interface RepoInstructionFile {
    path: string;
    content: string;
    /** The changed files this file governs, as a glob list. */
    appliesTo: string;
    truncated: boolean;
}

export interface RepoInstructionsContext {
    files: RepoInstructionFile[];
    /** Instruction files that exist but do not govern this change. */
    otherFiles: string[];
    /** Candidates left out by the file or byte budget; once it is spent they
     *  are not read. */
    dropped: string[];
    /** Candidates whose read failed, as `path: reason`. */
    unreadable?: string[];
    /** True when any governing content was cut or left out. */
    truncated: boolean;
    indexedCount: number;
    error?: string;
}

const EMPTY: RepoInstructionsContext = {
    files: [],
    otherFiles: [],
    dropped: [],
    unreadable: [],
    truncated: false,
    indexedCount: 0,
};

/**
 * Whether this review reads the repository's coding-agent instructions: the
 * repository opted in, and the adaptive-fit profile keeps optional context
 * (the same profiles that drop the call graph drop this).
 */
export function shouldCollectRepoInstructions(
    config: { repoInstructionsEnabled?: boolean } | null | undefined,
    adaptiveProfile?: { dropCallGraph?: boolean } | null,
): boolean {
    if (config?.repoInstructionsEnabled !== true) return false;
    return !adaptiveProfile?.dropCallGraph;
}

const normalize = (p: string): string =>
    p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

function scopeOf(path: string): string | null {
    return extractRepoSubdirFromIdeSource(normalize(path));
}

function governsByDirectory(scope: string | null, changed: string): boolean {
    return !scope || changed === scope || changed.startsWith(`${scope}/`);
}

function depth(scope: string | null): number {
    return scope ? scope.split('/').length : 0;
}

function dirOf(path: string): string | null {
    const slash = path.lastIndexOf('/');
    return slash > 0 ? path.slice(0, slash) : null;
}

/**
 * Prose instruction files whose directory contains at least one changed file,
 * root files first, then deeper ones. Tool configuration files are dropped.
 */
export function selectGoverningFiles(
    index: string[],
    changedFiles: string[],
): string[] {
    const changed = changedFiles.map(normalize);
    return index
        .map(normalize)
        .filter((p) => isAgentInstructionProseFile(p))
        .filter((p) => {
            const scope = scopeOf(p);
            return changed.some((c) => governsByDirectory(scope, c));
        })
        .sort(
            (a, b) =>
                depth(scopeOf(a)) - depth(scopeOf(b)) || a.localeCompare(b),
        );
}

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Cursor writes globs unquoted (`globs: *.spec.tsx`), which YAML rejects as an
 * alias, so when YAML fails each top-level `key: value` line is read as text.
 */
function parseFrontmatter(text: string): Record<string, unknown> | null {
    try {
        const parsed = yaml.load(text);
        return parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        const entries = text
            .split(/\r?\n/)
            .map((line) => /^([A-Za-z]\w*):\s*(.*?)\s*$/.exec(line))
            .filter((m): m is RegExpExecArray => m !== null)
            .map(([, key, value]): [string, unknown] => [
                key,
                value === 'true' ? true : value === 'false' ? false : value,
            ]);
        return entries.length ? Object.fromEntries(entries) : null;
    }
}

/**
 * Globs a file declares for itself: Cursor `.mdc` `globs:` (unless
 * `alwaysApply: true`) and Copilot `.instructions.md` `applyTo:`. `null` when
 * it declares none, so the directory rule decides.
 */
function declaredGlobs(path: string, content: string): string[] | null {
    const match = FRONTMATTER_RE.exec(content);
    if (!match) return null;

    const frontmatter = parseFrontmatter(match[1]);
    if (!frontmatter) return null;

    const lower = path.toLowerCase();
    let raw: unknown;
    if (lower.endsWith('.mdc')) {
        if (frontmatter.alwaysApply === true) return null;
        raw = frontmatter.globs;
    } else if (lower.endsWith('.instructions.md')) {
        raw = frontmatter.applyTo;
    } else {
        return null;
    }

    const globs = (Array.isArray(raw) ? raw : [raw])
        .filter((g): g is string => typeof g === 'string')
        .flatMap((g) => splitRulePathGlobs(g))
        .map((g) => g.trim())
        .filter(Boolean);
    return globs.length ? globs : null;
}

/**
 * A Cursor rule with frontmatter that neither always applies nor declares
 * globs: Cursor's agent loads it only when it asks for it.
 */
function loadsOnRequest(path: string, content: string): boolean {
    if (!path.toLowerCase().endsWith('.mdc')) return false;
    const match = FRONTMATTER_RE.exec(content);
    const frontmatter = match ? parseFrontmatter(match[1]) : null;
    if (!frontmatter || frontmatter.alwaysApply === true) return false;
    return declaredGlobs(path, content) === null;
}

function matchesDeclared(
    globs: string[],
    scope: string | null,
    changed: string,
): boolean {
    const relative =
        scope && changed.startsWith(`${scope}/`)
            ? changed.slice(scope.length + 1)
            : changed;
    const basename = changed.slice(changed.lastIndexOf('/') + 1);
    // A glob without a slash (`*.spec.tsx`) matches the file name anywhere
    // under the rule's directory.
    return globs.some(
        (g) =>
            isFileMatchingGlob(changed, [g]) ||
            isFileMatchingGlob(relative, [g]) ||
            (!g.includes('/') &&
                governsByDirectory(scope, changed) &&
                isFileMatchingGlob(basename, [g])),
    );
}

function truncateToBytes(text: string, maxBytes: number): string {
    const buffer = Buffer.from(text, 'utf8');
    if (buffer.length <= maxBytes) return text;
    return buffer
        .subarray(0, maxBytes)
        .toString('utf8')
        .replace(/�+$/, '');
}

/** A reference to another file in the repository: `@path` or a bare path. */
const POINTER_PATH =
    /^(?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.-]+)*\.(?:md|mdc|markdown|txt)$/i;
const IMPORT_RE =
    /(?:^|\s)@((?:\.{1,2}\/)*[\w.-]+(?:\/[\w.-]+)*\.(?:md|mdc|markdown|txt))(?=$|[\s),.;:])/gi;

/**
 * The files `content` points to, in order: whole lines that are a path
 * (`AI-AGENTS.md`, `../../AI-AGENTS.md`, `@ai-agents.md`) and Claude Code's
 * `@path` imports inside text. `pure`: the file holds nothing but pointers.
 */
export function pointersIn(content: string): { refs: string[]; pure: boolean } {
    const body = content.replace(FRONTMATTER_RE, '');
    const lines = body
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const refs: string[] = [];
    let pure = lines.length > 0;
    for (const line of lines) {
        const whole = line.replace(/^@/, '');
        if (POINTER_PATH.test(whole)) {
            refs.push(whole);
            continue;
        }
        pure = false;
        for (const match of line.matchAll(IMPORT_RE)) refs.push(match[1]);
    }
    return { refs: [...new Set(refs)], pure };
}

/** `ref` joined onto `base`; null when it climbs out of the repository. */
function joinInside(base: string, ref: string): string | null {
    const parts = base ? base.split('/') : [];
    for (const segment of ref.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') {
            if (!parts.length) return null;
            parts.pop();
        } else {
            parts.push(segment);
        }
    }
    return parts.length ? parts.join('/') : null;
}

/**
 * Where a pointer in `from` may lead, in the order tried: relative to the file
 * that holds it, then from the repository root. Paths that leave the
 * repository are left out.
 */
export function resolvePointer(ref: string, from: string): string[] {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
    const out: string[] = [];
    for (const base of [dir, '']) {
        const path = joinInside(base, ref);
        if (path && !out.includes(path)) out.push(path);
    }
    return out;
}

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/**
 * Reads the coding-agent instruction files that govern `changedFiles`, within
 * `REPO_INSTRUCTIONS_LIMITS`. Never throws: a git host failure yields an empty
 * result with `error` set, and a file that cannot be read is skipped and
 * listed in `unreadable`. Nothing is read once the file or byte budget is
 * fully spent.
 */
export async function collectRepoInstructions(params: {
    listFiles: () => Promise<string[]>;
    readFile: (path: string) => Promise<string | null>;
    changedFiles: string[];
}): Promise<RepoInstructionsContext> {
    const limits = REPO_INSTRUCTIONS_LIMITS;
    const changed = params.changedFiles.map(normalize);

    let index: string[];
    try {
        // A host can list one file twice; it takes one slot.
        index = [...new Set((await params.listFiles()).map(normalize))];
    } catch (error) {
        return { ...EMPTY, error: errorMessage(error) };
    }

    const prose = index.filter((p) => isAgentInstructionProseFile(p));
    const candidates = selectGoverningFiles(prose, changed);

    const files: RepoInstructionFile[] = [];
    const dropped: string[] = [];
    const unreadable: string[] = [];
    let total = 0;
    let truncated = false;

    // Each read once: a pointer's target is read to resolve it, then listed.
    const contents = new Map<string, string | null>();
    const read = async (path: string): Promise<string | null> => {
        if (!contents.has(path)) {
            let content: string | null = null;
            try {
                content = await params.readFile(path);
            } catch (error) {
                unreadable.push(`${path}: ${errorMessage(error)}`);
            }
            contents.set(path, content);
        }
        return contents.get(path) ?? null;
    };

    // Read nearest the change first, so a full budget drops the files
    // furthest from it; a pointer's targets go right after it and take its
    // place and scope. The prompt still lists them root first (`rank`).
    const rank = new Map(candidates.map((path, i) => [path, i]));
    const distance = (path: string) => {
        const scope = scopeOf(path);
        const gaps = changed
            .filter((c) => governsByDirectory(scope, c))
            .map((c) => depth(dirOf(c)) - depth(scope));
        return gaps.length ? Math.min(...gaps) : Infinity;
    };
    const queue: Array<{ path: string; appliesTo?: string; rank: number }> = [
        ...candidates,
    ]
        .sort(
            (a, b) => distance(a) - distance(b) || rank.get(a)! - rank.get(b)!,
        )
        .map((path) => ({ path, rank: rank.get(path)! }));
    const ranks = new Map<string, number>();
    const seen = new Set<string>(candidates);
    // A target can be named by pointers in several scopes; it applies to all
    // of them, and so do the files it points to.
    const scopes = new Map<string, Set<string>>();
    const pointedFrom = new Map<string, string[]>();
    const budgetFull = () =>
        files.length >= limits.maxFiles || total >= limits.maxTotalBytes;

    while (queue.length) {
        const { path, appliesTo: inherited, rank: at } = queue.shift()!;
        if (budgetFull()) {
            dropped.push(path);
            continue;
        }

        const content = await read(path);
        if (!content?.trim()) continue;

        let appliesTo = inherited;
        if (appliesTo === undefined) {
            if (loadsOnRequest(path, content)) continue;
            const scope = scopeOf(path);
            const globs = declaredGlobs(path, content);
            if (
                globs &&
                !changed.some((c) => matchesDeclared(globs, scope, c))
            ) {
                continue;
            }
            appliesTo = globs ? globs.join(',') : scope ? `${scope}/**` : '**';
            scopes.set(path, new Set([appliesTo]));
        }

        const { refs, pure } = pointersIn(content);
        const targets: string[] = [];
        let resolved = false;
        for (const ref of refs.slice(0, limits.maxPointersPerFile)) {
            const candidatesForRef = resolvePointer(ref, path);
            const known = candidatesForRef.find((c) => seen.has(c));
            if (known) {
                pointedFrom.set(known, [
                    ...(pointedFrom.get(known) ?? []),
                    path,
                ]);
                resolved = true;
                continue;
            }
            // Once the targets already found fill the budget, the rest are
            // left out unread.
            if (files.length + targets.length >= limits.maxFiles) {
                if (candidatesForRef.length) dropped.push(candidatesForRef[0]);
                continue;
            }
            for (const target of candidatesForRef) {
                if ((await read(target))?.trim()) {
                    targets.push(target);
                    seen.add(target);
                    pointedFrom.set(target, [path]);
                    resolved = true;
                    break;
                }
            }
        }
        queue.unshift(
            ...targets.map((target) => ({ path: target, appliesTo, rank: at })),
        );
        // A file that only points elsewhere holds no instruction of its own:
        // its targets are listed instead.
        if (pure && resolved) continue;

        let text = truncateToBytes(content.trim(), limits.maxBytesPerFile);
        let cut = text.length < content.trim().length;
        const remaining = limits.maxTotalBytes - total;
        if (Buffer.byteLength(text) > remaining) {
            if (remaining < limits.minUsefulBytes) {
                dropped.push(path);
                continue;
            }
            text = truncateToBytes(text, remaining);
            cut = true;
        }

        total += Buffer.byteLength(text);
        truncated = truncated || cut;
        files.push({ path, content: text, appliesTo, truncated: cut });
        ranks.set(path, at);
    }

    // Spread each pointer's scopes to its targets until nothing changes; the
    // graph is at most a few files, and cycles settle.
    let changedScopes = true;
    while (changedScopes) {
        changedScopes = false;
        for (const [target, pointers] of pointedFrom) {
            const into = scopes.get(target) ?? new Set<string>();
            scopes.set(target, into);
            for (const pointer of pointers) {
                for (const scope of scopes.get(pointer) ?? []) {
                    if (!into.has(scope)) {
                        into.add(scope);
                        changedScopes = true;
                    }
                }
            }
        }
    }

    const used = new Set([...files.map((f) => f.path), ...dropped]);
    return {
        files: files
            .map((file, read) => ({ file, read }))
            .sort(
                (a, b) =>
                    ranks.get(a.file.path)! - ranks.get(b.file.path)! ||
                    a.read - b.read,
            )
            .map(({ file }) => ({
                ...file,
                appliesTo: [
                    ...(scopes.get(file.path) ?? [file.appliesTo]),
                ].join(','),
            })),
        otherFiles: prose
            .filter((p) => !used.has(p))
            .slice(0, limits.maxOtherFiles),
        dropped,
        unreadable,
        truncated: truncated || dropped.length > 0,
        indexedCount: prose.length,
    };
}

/** Shorter quotes could match by chance, so they never count as a citation. */
const MIN_QUOTE_CHARS = 12;
/** Quote marks an instruction may itself contain and still match whole. */
const MAX_INNER_QUOTE_MARKS = 6;

const straightenQuotes = (text: string): string =>
    text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

/**
 * Lowercased text without markdown (heading, quote and list markers, links,
 * emphasis, code ticks) and with whitespace collapsed, so a finding that
 * quotes an instruction without its formatting still matches.
 */
function normalizeInstructionText(text: string): string {
    return straightenQuotes(text)
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
        .replace(/[*_`~]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

const trimPunctuation = (text: string): string =>
    text.replace(/^[\s.,;:!?]+|[\s.,;:!?]+$/g, '');

/**
 * Whether `path` is a coding-agent instruction file, or a file the review
 * collected as one (a pointer's target such as `docs/guide.md`).
 */
export function isRepoInstructionFile(
    path: string | undefined,
    context: RepoInstructionsContext | undefined,
): boolean {
    if (!path) return false;
    const normalized = normalize(path);
    return (
        isAgentInstructionProseFile(normalized) ||
        (context?.files ?? []).some((f) => normalize(f.path) === normalized)
    );
}

// The file as the authority for a claim: its subject ("CLAUDE.md says",
// "CLAUDE.md, added in this PR, requires") or the direct object of one
// ("per CLAUDE.md", "violates the CLAUDE.md rule", "breaks `AGENTS.md`").
const CITED_AS_SUBJECT =
    /\u00a7F[`'"]?\W*(?:[\w-]+\W+){0,4}?(?:says|said|states|stated|requires|required|asks|forbids|mandates|prescribes|instructs|demands)\b/i;
const CITED_AS_OBJECT =
    /\b(?:per|according to|violates|violated|violating|violation of|breaks|breaking|contradicts|stated in|defined in|rule in|rules in)\s+(?:the\s+)?[`'"]?\u00a7F/i;

/**
 * Whether a finding reasons from an instruction file (see
 * `isRepoInstructionFile`): one of its sentences takes the file as the
 * authority for its claim. A file the code under review names
 * (`existingCode`) is not a citation: the finding is about code that handles
 * that file.
 */
export function citesRepoInstruction(
    finding: {
        suggestionContent?: string;
        existingCode?: string;
    },
    context: RepoInstructionsContext | undefined,
): boolean {
    // Only the code under review: improvedCode is the model's suggestion
    // and may repeat the citation in a comment.
    const code = finding.existingCode ?? '';
    const sentences = (finding.suggestionContent ?? '').split(
        /(?<=[.!?;])\s+|\n+/,
    );
    return sentences.some((sentence) => {
        let cited = false;
        const marked = sentence.replace(/[\w./@-]+/g, (token) => {
            const path = token.replace(/^@/, '').replace(/[.,:;]+$/, '');
            if (
                !path.includes('.') ||
                !isRepoInstructionFile(path, context) ||
                code.includes(path)
            ) {
                return token;
            }
            cited = true;
            return '\u00a7F';
        });
        return (
            cited &&
            (CITED_AS_SUBJECT.test(marked) || CITED_AS_OBJECT.test(marked))
        );
    });
}

/**
 * Whether `text` (a finding's content) quotes one of the collected
 * instruction files: some span of it between two double quotes (see
 * MAX_INNER_QUOTE_MARKS), normalized, appears in a file's normalized text. A quote cut with an ellipsis matches when every part
 * appears in the same file.
 */
export function quotesRepoInstruction(
    text: string,
    context: RepoInstructionsContext | undefined,
): boolean {
    const corpus = (context?.files ?? []).map((f) =>
        normalizeInstructionText(f.content),
    );
    if (!corpus.length) return false;

    // A span between two quote marks with up to MAX_INNER_QUOTE_MARKS between
    // them is a candidate, so an instruction that itself contains quotes
    // (`Use "strict" mode.`) is compared whole instead of as the short pieces
    // between its quotes. Bounding the gap keeps the work linear in the
    // number of quotes; the first match returns.
    const longest = Math.max(...corpus.map((file) => file.length));
    const straight = straightenQuotes(text);
    const marks = [...straight.matchAll(/"/g)].map((m) => m.index ?? 0);
    for (let i = 0; i < marks.length; i++) {
        const last = Math.min(marks.length - 1, i + 1 + MAX_INNER_QUOTE_MARKS);
        for (let j = i + 1; j <= last; j++) {
            const parts = straight
                .slice(marks[i] + 1, marks[j])
                .split(/\.{3}|\u2026/)
                .map((p) => trimPunctuation(normalizeInstructionText(p)))
                .filter(Boolean);
            const length = parts.reduce((sum, p) => sum + p.length, 0);
            if (length < MIN_QUOTE_CHARS || length > longest) continue;
            if (corpus.some((file) => parts.every((p) => file.includes(p)))) {
                return true;
            }
        }
    }
    return false;
}
