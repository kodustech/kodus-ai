import type { AgentPolicy, StepDirectives, StepView } from '@libs/agent-harness/domain/contracts/policy.contract';
import type { AgentMessage } from '@libs/agent-harness/domain/contracts/run-state.contract';

import { isSecretFile, modelView, READ_LIMITS, type RepoReader } from './repo-reader';

/**
 * Two optional ways to make the recipe author's context smaller, both off by
 * default (the eval compares them, run-authors.ts v3 to v5). Every step sends
 * the whole conversation again, so a file read at step 2 is paid for at every
 * step after it, and the first steps are almost always reads of the same
 * kinds of files.
 *
 * - clearStaleReads: past a size, the results of reads older than the last
 *   few steps become a one-line stub (Anthropic's "clear tool results").
 * - prefetch: those files are read before the first step and put in the
 *   first message, so the model does not spend steps on them.
 */
export interface ClearStaleReadsOptions {
    /** Estimated tokens of the conversation past which stale reads are cleared, and the growth after a clearing before the next one. */
    afterTokens?: number;
    /** Steps whose results are never cleared, counted back from the last one. */
    keepSteps?: number;
}

export interface PrefetchOptions {
    /** Characters of every prefetched file together. */
    maxChars?: number;
}

export interface RecipeAuthorContextOptions {
    clearStaleReads?: boolean | ClearStaleReadsOptions;
    prefetch?: boolean | PrefetchOptions;
}

/** What the options did in one run, on the result when any of them was on. */
export interface RecipeAuthorContextReport {
    /** Batches of clearing, each one change of the message prefix. */
    clearings: number;
    /** Tool results cleared over the run. */
    clearedResults: number;
    /** The files the first message carried, in its order. */
    prefetched: string[];
}

export const RECIPE_AUTHOR_CONTEXT_DEFAULTS = {
    afterTokens: 40_000,
    keepSteps: 2,
    prefetchChars: 24_000,
} as const;

const count = (v: unknown, fallback: number, min: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.floor(v)) : fallback);

/** The clearing options with their defaults, or undefined when it is off. */
export function clearStaleReadsOptions(o: RecipeAuthorContextOptions['clearStaleReads']): Required<ClearStaleReadsOptions> | undefined {
    if (!o) return undefined;
    const given = o === true ? {} : o;
    return {
        afterTokens: count(given.afterTokens, RECIPE_AUTHOR_CONTEXT_DEFAULTS.afterTokens, 1),
        keepSteps: count(given.keepSteps, RECIPE_AUTHOR_CONTEXT_DEFAULTS.keepSteps, 0),
    };
}

/** The prefetch options with their defaults, or undefined when it is off. */
export function prefetchOptions(o: RecipeAuthorContextOptions['prefetch']): Required<PrefetchOptions> | undefined {
    if (!o) return undefined;
    const given = o === true ? {} : o;
    return { maxChars: count(given.maxChars, RECIPE_AUTHOR_CONTEXT_DEFAULTS.prefetchChars, 0) };
}

// ── clearStaleReads ──────────────────────────────────────────────────────────

/** The tools whose results may be cleared: reads the model can run again. Never submit_recipe (its refusals say what to fix). */
const CLEARABLE = new Set(['list_files', 'read_file', 'find_files']);
/** A result shorter than this stays: clearing it saves little and an error message is worth keeping. */
const MIN_CLEAR_CHARS = 400;
/** Characters per token, low, as the stop policy counts. */
const CHARS_PER_TOKEN = 3;

interface ToolResultPart {
    type: 'tool-result';
    toolCallId: string;
    toolName: string;
    output: { type: string; value?: unknown };
}

const isResultPart = (p: unknown): p is ToolResultPart =>
    !!p && typeof p === 'object' && (p as ToolResultPart).type === 'tool-result' && typeof (p as ToolResultPart).toolCallId === 'string';

/** The size of the conversation as the provider gets it, estimated from its characters (structured parts as JSON). */
export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
    let chars = 0;
    for (const m of messages) chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
    return Math.ceil(chars / CHARS_PER_TOKEN);
}

function inputOf(input: unknown): Record<string, unknown> {
    if (typeof input === 'string') {
        try {
            const v = JSON.parse(input);
            return v && typeof v === 'object' ? v : {};
        } catch {
            // Tool input that is not JSON carries no fields.
            return {};
        }
    }
    return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

/** The argument a read names: read_file's and list_files' path, find_files' glob. */
function argOf(toolName: string, input: unknown): string {
    const v = inputOf(input)[toolName === 'find_files' ? 'glob' : 'path'];
    return typeof v === 'string' ? v.trim().slice(0, 200) : '';
}

/** One free run again of a cleared read, so a stub never costs the model its read budget. */
export function rerunKey(toolName: string, input: unknown): string {
    return `${toolName}\0${argOf(toolName, input)}`;
}

/** What a cleared result says instead: what it was and how big, and that it can be read again. */
export function clearedStub(toolName: string, input: unknown, value: string): string {
    const arg = argOf(toolName, input);
    const n = value.split('\n').length;
    if (toolName === 'read_file') return `[read_file ${arg}: ${n} lines, cleared to save context; read it again if you need it]`;
    if (toolName === 'list_files') return `[list_files ${arg || '/'}: ${n} entries, cleared to save context; list it again if you need it]`;
    return `[find_files ${arg}: ${n} paths, cleared to save context; run it again if you need it]`;
}

/** The input of every tool call the assistant made, by call id. */
function callInputs(messages: readonly AgentMessage[]): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const m of messages) {
        if (m.role !== 'assistant') continue;
        if (Array.isArray(m.content))
            for (const p of m.content as unknown[]) {
                const c = p as { type?: string; toolCallId?: string; input?: unknown; args?: unknown };
                if (c?.type === 'tool-call' && typeof c.toolCallId === 'string') out.set(c.toolCallId, c.input ?? c.args);
            }
        for (const tc of m.toolCalls ?? []) if (!out.has(tc.id)) out.set(tc.id, tc.input);
    }
    return out;
}

/**
 * The messages with every stubbed result's output replaced. The part keeps its
 * call id and tool name, so each tool call still has its result; nothing but
 * a tool message's result parts changes.
 */
export function applyStubs(messages: readonly AgentMessage[], stubs: ReadonlyMap<string, string>): AgentMessage[] {
    if (!stubs.size) return [...messages];
    return messages.map((m) => {
        if (m.role !== 'tool' || !Array.isArray(m.content)) return m;
        let changed = false;
        const content = (m.content as unknown[]).map((p) => {
            if (!isResultPart(p) || !stubs.has(p.toolCallId)) return p;
            const value = stubs.get(p.toolCallId)!;
            if (p.output?.type === 'text' && p.output.value === value) return p;
            changed = true;
            return { ...p, output: { type: 'text', value } };
        });
        return changed ? { ...m, content } : m;
    });
}

/** The results that may be cleared: of a read tool, text, long enough, and from a step older than the last `keepSteps`. */
function staleResults(messages: readonly AgentMessage[], keepSteps: number, stubs: ReadonlyMap<string, string>): Array<{ id: string; toolName: string; value: string }> {
    const steps = messages.filter((m) => m.role === 'assistant').length;
    const out: Array<{ id: string; toolName: string; value: string }> = [];
    let step = -1;
    for (const m of messages) {
        if (m.role === 'assistant') step++;
        if (m.role !== 'tool' || !Array.isArray(m.content) || step < 0 || step >= steps - keepSteps) continue;
        for (const p of m.content as unknown[]) {
            if (!isResultPart(p) || stubs.has(p.toolCallId) || !CLEARABLE.has(p.toolName)) continue;
            if (p.output?.type !== 'text' || typeof p.output.value !== 'string' || p.output.value.length < MIN_CLEAR_CHARS) continue;
            out.push({ id: p.toolCallId, toolName: p.toolName, value: p.output.value });
        }
    }
    return out;
}

/**
 * Clears stale reads in batches. Once the conversation passes `afterTokens`,
 * every result that may be cleared is, at once; the next batch waits until
 * the conversation grew by another `afterTokens`. Between batches every step
 * sends the same stubs, so the message prefix does not change and a
 * provider's prompt cache keeps hitting. The system prompt, the first message
 * (the Facts), the model's own messages, injected notes and submit_recipe
 * results are never touched: only the output of read tool results.
 *
 * Placed before RecipeAuthorStopPolicy: what a batch saved comes off the tool
 * output the stop policy adds to the last step's cost.
 */
export class ClearStaleReadsPolicy implements AgentPolicy {
    readonly name = 'recipe-author-clear-stale-reads';
    private readonly stubs = new Map<string, string>();
    private nextAt: number;
    clearings = 0;
    clearedResults = 0;

    constructor(
        private readonly opts: Required<ClearStaleReadsOptions>,
        private readonly state: { pendingChars: number; rereads?: Set<string> },
    ) {
        this.nextAt = opts.afterTokens;
    }

    prepareStep(view: StepView): StepDirectives {
        // The runner may or may not carry an earlier step's messages on (AI SDK versions differ): the stubs are applied every step.
        const kept = applyStubs(view.messages, this.stubs);
        const before = estimateMessagesTokens(kept);
        const unchanged: StepDirectives = this.stubs.size ? { messages: kept } : {};
        if (before < this.nextAt) return unchanged;
        const stale = staleResults(kept, this.opts.keepSteps, this.stubs);
        if (!stale.length) return unchanged;
        const inputs = callInputs(kept);
        for (const r of stale) {
            const input = inputs.get(r.id);
            this.stubs.set(r.id, clearedStub(r.toolName, input, r.value));
            this.state.rereads?.add(rerunKey(r.toolName, input));
        }
        const messages = applyStubs(kept, this.stubs);
        const after = estimateMessagesTokens(messages);
        this.nextAt = after + this.opts.afterTokens;
        this.clearings++;
        this.clearedResults += stale.length;
        this.state.pendingChars -= (before - after) * CHARS_PER_TOKEN;
        return {
            messages,
            emit: [
                {
                    kind: 'context.clear',
                    detail: { beforeTokens: before, afterTokens: after, savedTokens: before - after, cleared: stale.length, clearing: this.clearings, step: view.stepNumber },
                },
            ],
        };
    }
}

// ── prefetch ─────────────────────────────────────────────────────────────────

/** Root manifests and version pins, small and read first, whole (cut at FILE_CHARS), in this order. */
export const PREFETCH_ROOT_FILES = [
    'package.json',
    'pnpm-workspace.yaml',
    '.yarnrc.yml',
    'nx.json',
    'turbo.json',
    '.nvmrc',
    '.node-version',
    '.tool-versions',
    'go.mod',
    'requirements.txt',
    'pyproject.toml',
] as const;
/** How the project runs its processes; often long, so after the compose files and the Dockerfile. */
const PREFETCH_RUN_FILES = ['Procfile', 'Makefile'] as const;
/** The first lockfile found gives only its header (the version that wrote it). */
const PREFETCH_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock'] as const;
/** The compose files tried by name when the root cannot be listed. */
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'] as const;
const COMPOSE = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/;
const README = ['README.md', 'readme.md', 'Readme.md', 'README.markdown'] as const;
/** What each member of a workspace gives: its package manifests only. */
export const PREFETCH_MEMBER_FILES = ['package.json', 'go.mod', 'pyproject.toml', 'requirements.txt'] as const;

const FILE_CHARS = 8_000;
const WORKFLOW_CHARS = 6_000;
const WORKFLOWS = 4;
const README_CHARS = 4_000;
const LOCK_LINES = 20;
const LOCK_CHARS = 800;
/** Below this, a file that does not fit whole is left out instead of cut to what is left. */
const MIN_PARTIAL = 1_000;
/** Workflows that boot or test the app come first. */
const CI_WORKFLOW = /(?:^|[-_.])(?:ci|tests?|e2e|build|checks?|integration|pr|pull[-_]request)(?:[-_.]|$)/i;
const RUN_HEADING =
    /\b(?:run(?:ning)?|start(?:ing|ed)?|quick ?start|develop(?:ment|ing)?|local(?:ly)?|install(?:ation|ing)?|set ?up|docker|self-?host(?:ing|ed)?|build(?:ing)?|usage)\b/i;

/** The README's sections on running the project (a heading about running, setup or Docker, down to the next heading of its level), or null. */
export function readmeRunSections(text: string): string | null {
    const lines = text.split('\n');
    const taken: string[] = [];
    let fence = false;
    let level = 0;
    for (const line of lines) {
        if (/^\s*(?:```|~~~)/.test(line)) fence = !fence;
        const h = fence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
        if (h && level && h[1].length <= level) level = 0;
        if (h && !level && RUN_HEADING.test(h[2])) level = h[1].length;
        if (level) taken.push(line);
    }
    const out = taken.join('\n').trim();
    return out ? out : null;
}

interface Candidate {
    /** Where the model reads it: the primary's path, or ../<alias>/<path>. */
    label: string;
    read: () => Promise<string | null>;
    /** Characters of it at most. */
    cap: number;
    /** A heading suffix, as "(first 20 lines)". */
    note?: string;
}

const cutTo = (text: string, chars: number) => (text.length <= chars ? text : `${text.slice(0, chars)}\n[cut at ${chars} characters; read_file shows the whole file]`);

async function safeRead(reader: RepoReader, path: string, maxBytes: number): Promise<string | null> {
    if (isSecretFile(path)) return null;
    // Prefetched context only: a file that cannot be read is left out, and read_file can still ask for it.
    return reader.read(path, maxBytes).catch(() => null);
}

/** The view read_file gives (redacted, secret-named values masked), at most `cap` characters. */
const fileCandidate = (reader: RepoReader, path: string, label: string, cap: number): Candidate => ({
    label,
    cap,
    read: async () => {
        const text = await safeRead(reader, path, READ_LIMITS.fileBytes + 1);
        return text === null ? null : modelView(path, text);
    },
});

async function listOr(reader: RepoReader, dir: string): Promise<string[] | null> {
    // null is "no listing", which the caller already handles (fixed names tried, globs skipped).
    return reader.list(dir).catch(() => null);
}

/** The files to read for one repository at the root, in order. With no root listing, the fixed names are tried and globs skipped. */
async function rootCandidates(reader: RepoReader, root: readonly string[] | null): Promise<{ manifests: Candidate[]; rest: Candidate[] }> {
    const has = (f: string) => !root || root.includes(f);
    const manifests = PREFETCH_ROOT_FILES.filter(has).map((f) => fileCandidate(reader, f, f, FILE_CHARS));
    const lock = PREFETCH_LOCKFILES.find((f) => root?.includes(f)) ?? (root ? undefined : PREFETCH_LOCKFILES[0]);
    if (lock)
        manifests.push({
            label: lock,
            note: `(first ${LOCK_LINES} lines)`,
            cap: LOCK_CHARS,
            read: async () => {
                const text = await safeRead(reader, lock, 4 * 1024);
                return text === null ? null : modelView(lock, text.split('\n').slice(0, LOCK_LINES).join('\n'));
            },
        });
    const compose = root ? root.filter((f) => COMPOSE.test(f)).sort() : [...COMPOSE_NAMES];
    const rest: Candidate[] = compose.map((f) => fileCandidate(reader, f, f, FILE_CHARS));
    if (has('Dockerfile')) rest.push(fileCandidate(reader, 'Dockerfile', 'Dockerfile', FILE_CHARS));
    for (const f of PREFETCH_RUN_FILES.filter(has)) rest.push(fileCandidate(reader, f, f, FILE_CHARS));
    if (!root || root.includes('.devcontainer/'))
        rest.push(fileCandidate(reader, '.devcontainer/devcontainer.json', '.devcontainer/devcontainer.json', FILE_CHARS));
    if (!root || root.includes('.github/')) {
        const workflows = ((await listOr(reader, '.github/workflows')) ?? [])
            .filter((f) => /^[\w.-]+\.ya?ml$/.test(f))
            .sort((a, b) => Number(!CI_WORKFLOW.test(a)) - Number(!CI_WORKFLOW.test(b)) || (a < b ? -1 : a > b ? 1 : 0))
            .slice(0, WORKFLOWS);
        for (const w of workflows) rest.push(fileCandidate(reader, `.github/workflows/${w}`, `.github/workflows/${w}`, WORKFLOW_CHARS));
    }
    const readme = README.find((f) => root?.includes(f)) ?? (root ? undefined : README[0]);
    if (readme)
        rest.push({
            label: readme,
            note: '(run sections)',
            cap: README_CHARS,
            read: async () => {
                const text = await safeRead(reader, readme, READ_LIMITS.fileBytes + 1);
                return text === null ? null : readmeRunSections(modelView(readme, text));
            },
        });
    return { manifests, rest };
}

/**
 * The block of files the first message carries, and which files it holds, in
 * a fixed order: the root manifests and version pins, the lockfile's header,
 * each member's package manifests (a workspace), then the compose files, the
 * root Dockerfile, the Procfile and Makefile, the devcontainer, up to four CI workflows (those that test
 * or build first) and the README's run sections. Each is the view read_file
 * gives (secret files never, values redacted), cut per file; past `maxChars`
 * a file is cut to what is left, or named as left out. A failed read only
 * leaves the file out. No model and no tool call: the reads count against
 * nothing.
 */
export async function prefetchContext(
    reader: RepoReader,
    root: readonly string[] | null,
    maxChars: number,
    members: ReadonlyArray<{ alias: string; reader: RepoReader }> = [],
): Promise<{ text: string; files: string[] }> {
    const primary = await rootCandidates(reader, root);
    const memberCandidates: Candidate[] = [];
    for (const m of members) {
        const listed = await listOr(m.reader, '');
        for (const f of PREFETCH_MEMBER_FILES) if (!listed || listed.includes(f)) memberCandidates.push(fileCandidate(m.reader, f, `../${m.alias}/${f}`, FILE_CHARS));
    }
    const parts: string[] = [];
    const files: string[] = [];
    const left: string[] = [];
    let used = 0;
    for (const c of [...primary.manifests, ...memberCandidates, ...primary.rest]) {
        const body = await c.read();
        if (body === null || !body.trim()) continue;
        const head = `--- ${c.label}${c.note ? ` ${c.note}` : ''} ---\n`;
        const whole = `${head}${cutTo(body, c.cap)}`;
        // Each file after the first is joined with a blank line, counted in the budget.
        const room = maxChars - used - (parts.length ? 2 : 0);
        let part: string;
        if (whole.length <= room) part = whole;
        else if (room >= MIN_PARTIAL) part = `${head}${cutTo(body, Math.max(0, room - head.length - 80))}`;
        else {
            left.push(c.label);
            continue;
        }
        used += part.length + (parts.length ? 2 : 0);
        parts.push(part);
        files.push(c.label);
    }
    if (!parts.length) return { text: '', files: [] };
    const tail = left.length ? `\n\nLeft out to keep this message small (read them if you need them): ${left.join(', ')}` : '';
    return {
        text: `Files Kodus read for you before you started (the view read_file gives: redacted, cut where marked). They do not count against your read budget; do not read them again:\n\n${parts.join('\n\n')}${tail}`,
        files,
    };
}
