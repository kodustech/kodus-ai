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
        index = (await params.listFiles()).map(normalize);
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

    for (const path of candidates) {
        if (files.length >= limits.maxFiles || total >= limits.maxTotalBytes) {
            dropped.push(path);
            continue;
        }

        let content: string | null;
        try {
            content = await params.readFile(path);
        } catch (error) {
            unreadable.push(`${path}: ${errorMessage(error)}`);
            continue;
        }
        if (!content?.trim()) continue;

        if (loadsOnRequest(path, content)) continue;

        const scope = scopeOf(path);
        const globs = declaredGlobs(path, content);
        if (globs && !changed.some((c) => matchesDeclared(globs, scope, c))) {
            continue;
        }

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
        files.push({
            path,
            content: text,
            appliesTo: globs ? globs.join(',') : scope ? `${scope}/**` : '**',
            truncated: cut,
        });
    }

    const used = new Set([...files.map((f) => f.path), ...dropped]);
    return {
        files,
        otherFiles: prose
            .filter((p) => !used.has(p))
            .slice(0, limits.maxOtherFiles),
        dropped,
        unreadable,
        truncated: truncated || dropped.length > 0,
        indexedCount: prose.length,
    };
}
