import { posix } from 'path';
import ts from 'typescript';

import { READ_MANY_MAX, type RepoReader } from '../repo-reader';
import { aliasesOf, packageOf, type PathAliases, type ResolveContext, resolveSpecifier, type WorkspacePackage } from './resolve';
import { routesOf } from './routes';

// Reverse reachability over a static JS/TS import graph (docs §9.8): a
// changed file with no route of its own maps to the routes of the files that
// import it, directly or through other files. The graph is read through the
// planner's RepoReader (the Git API in production) at one commit, and only
// in part: files are read nearest the changed files first, to a fixed number
// of reads, of reader calls, of bytes scanned and a fixed time, and what was
// read is kept per commit for the next round. A reader that reads many files
// in one call (readMany) is asked for a whole batch at once, so a cold plan
// costs a few dozen calls to the Git platform instead of one a file (the
// installation's rate limit is shared with Kody's code review). Imports are
// listed by TypeScript's pre-processor (a scanner, not a compiler), yielding
// to the event loop between files; nothing of the repository is executed.

export const IMPORT_GRAPH_LIMITS = {
    /**
     * Code files one call reads (the changed files at the head not counted), by
     * default; a caller may give another budget (ImportGraphBudget). 400 reads
     * found an HTTP route for 17/61 diffs of the corpus, 2,000 for 30/61; the
     * wall-clock cap below bounds the call whatever the budget.
     */
    reads: 1_000,
    /** The most reads a caller's budget may ask for. */
    maxReads: 5_000,
    /** tsconfig/jsconfig/package.json files read to resolve aliases and workspace packages. */
    configReads: 60,
    /** Bytes of one file. */
    fileBytes: 128 * 1024,
    parallel: 8,
    /** Import hops from a changed file to a file with routes. */
    depth: 6,
    /** Files the reverse walk visits from one changed file. */
    nodes: 3_000,
    /**
     * Imports past which a route file reached through two or more hops is an
     * app root (a server that imports every module), whose routes say nothing
     * about the changed file.
     */
    hubImports: 25,
    /** Routes kept per changed file, nearest first. */
    routesPerFile: 8,
    /** Paths of the tree considered. */
    treePaths: 100_000,
    /** Directories listed when the reader has no whole-tree call. */
    listDirs: 400,
    /** Imports kept per file. */
    importsPerFile: 400,
    /** Files read between two re-rankings of what to read next. */
    batch: 40,
    /** Time one call spends reading before it answers with what it read. */
    millis: 15_000,
    /**
     * Reader calls one call makes (tree, listings, reads, batch reads), by
     * default; a caller may give another bound (ImportGraphBudget). With a
     * reader that reads many files at once, the default read budget takes
     * about 30 calls; a reader of one file a call reaches this bound first.
     */
    calls: 300,
    /** The most calls a caller's bound may ask for. */
    maxCalls: 10_000,
    /** Bytes of file text scanned (imports and routes) in one call: past it no file is read. */
    scanBytes: 32 * 1024 * 1024,
    /** Bytes scanned between two yields to the event loop (TypeScript's pre-processor reads about 70 MB/s). */
    yieldBytes: 256 * 1024,
    /** Commits kept in a cache. */
    cacheCommits: 4,
} as const;

export interface ReachedRoute {
    /** `METHOD /path`, as the file declares it (before any mount prefix). */
    route: string;
    /** The file that declares the route. */
    file: string;
    /** Imports between the changed file and that file; 0 when the changed file declares the route itself. */
    hops: number;
}

interface GraphNode {
    imports: string[];
    routes: string[];
}

interface CommitGraph {
    paths: string[];
    files: Set<string>;
    ctx: ResolveContext;
    /** Files read at this commit; null when the read gave nothing. */
    nodes: Map<string, GraphNode | null>;
}

/** What the planner kept of the commits it read, by a key that names one commit of one repository. */
export class ImportGraphCache {
    private readonly commits = new Map<string, Promise<CommitGraph | undefined>>();
    get(key: string) {
        const hit = this.commits.get(key);
        if (hit !== undefined) {
            this.commits.delete(key);
            this.commits.set(key, hit);
        }
        return hit;
    }
    set(key: string, value: Promise<CommitGraph | undefined>) {
        this.commits.set(key, value);
        while (this.commits.size > IMPORT_GRAPH_LIMITS.cacheCommits) this.commits.delete(this.commits.keys().next().value as string);
    }
    delete(key: string) {
        this.commits.delete(key);
    }
}

const sharedCache = new ImportGraphCache();

/** What one call may spend reading; absent fields are IMPORT_GRAPH_LIMITS'. The 15 s wall-clock cap is not a budget field. */
export interface ImportGraphBudget {
    /** Code files read, 1 to IMPORT_GRAPH_LIMITS.maxReads. */
    reads?: number;
    /** Reader calls, 1 to IMPORT_GRAPH_LIMITS.maxCalls. */
    calls?: number;
}

/** The reads a call may make: the caller's budget when it is a positive integer, capped; the default otherwise. */
export function importGraphReadsOf(budget: ImportGraphBudget | undefined): number {
    const reads = budget?.reads;
    if (reads === undefined || !Number.isInteger(reads) || reads < 1) return IMPORT_GRAPH_LIMITS.reads;
    return Math.min(reads, IMPORT_GRAPH_LIMITS.maxReads);
}

/** The reader calls a call may make: the caller's bound when it is a positive integer, capped; the default otherwise. */
export function importGraphCallsOf(budget: ImportGraphBudget | undefined): number {
    const calls = budget?.calls;
    if (calls === undefined || !Number.isInteger(calls) || calls < 1) return IMPORT_GRAPH_LIMITS.calls;
    return Math.min(calls, IMPORT_GRAPH_LIMITS.maxCalls);
}

/** What one call has spent: reader calls and bytes scanned, and when the scan last gave the event loop a turn. */
class Spend {
    calls = 0;
    scanned = 0;
    private sinceYield = 0;
    constructor(readonly maxCalls: number) {}
    get callsLeft() {
        return Math.max(0, this.maxCalls - this.calls);
    }
    get scanLeft() {
        return IMPORT_GRAPH_LIMITS.scanBytes - this.scanned;
    }
    /** Counts the bytes scanned, and yields once enough were scanned since the last yield. */
    async scan(bytes: number) {
        this.scanned += bytes;
        this.sinceYield += bytes;
        if (this.sinceYield < IMPORT_GRAPH_LIMITS.yieldBytes) return;
        this.sinceYield = 0;
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

/**
 * The text of each path, through one readMany call per READ_MANY_MAX paths
 * when the reader has one, else one read a path, IMPORT_GRAPH_LIMITS.parallel
 * at a time; never more calls than `spend` has left (the paths past it are
 * not in the answer). A failed call reads its paths as none.
 */
async function readAll(reader: RepoReader, paths: readonly string[], spend: Spend): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const max = IMPORT_GRAPH_LIMITS.fileBytes;
    if (reader.readMany) {
        for (let i = 0; i < paths.length && spend.callsLeft > 0; i += READ_MANY_MAX) {
            const chunk = paths.slice(i, i + READ_MANY_MAX);
            spend.calls++;
            const got = await reader.readMany([...chunk], max).catch(() => new Map<string, string | null>());
            for (const p of chunk) out.set(p, got.get(p) ?? null);
        }
        return out;
    }
    const allowed = paths.slice(0, spend.callsLeft);
    for (let i = 0; i < allowed.length; i += IMPORT_GRAPH_LIMITS.parallel) {
        const chunk = allowed.slice(i, i + IMPORT_GRAPH_LIMITS.parallel);
        spend.calls += chunk.length;
        const texts = await Promise.all(chunk.map((p) => reader.read(p, max).catch(() => null)));
        chunk.forEach((p, k) => out.set(p, texts[k]));
    }
    return out;
}

const CODE_FILE = /\.[cm]?[jt]sx?$/;
const SKIPPED_DIR = /(^|\/)(node_modules|vendor|dist|build|out|\.next|\.nuxt|\.turbo|\.git|coverage|storybook-static)\//;
/** Tests, stories and mocks import what they check; they are not a way in from outside. */
const NOT_A_WAY_IN = /\.(spec|test|stories|story|e2e|cy)\.[cm]?[jt]sx?$|(^|\/)(__tests__|__mocks__|__fixtures__|test|tests|e2e|cypress|playwright|fixtures|mocks?)\//;
const CONFIG_FILE = /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|package\.json)$/;
const ROUTE_LIKE = /(controller|resolver|routes?|router|handler|server|app|main|api|endpoints?|page|layout)\.[cm]?[jt]sx?$|(^|\/)(app|pages|routes|api)\//i;

const isGraphFile = (p: string) => CODE_FILE.test(p) && !p.endsWith('.d.ts') && !SKIPPED_DIR.test(p) && !NOT_A_WAY_IN.test(p);
const dirOf = (p: string) => {
    const d = posix.dirname(p);
    return d === '.' ? '' : d;
};

/** The import specifiers of a JS/TS file: ES imports and re-exports, require, dynamic import. */
function importsOf(text: string): string[] {
    try {
        return ts
            .preProcessFile(text, true, true)
            .importedFiles.map((f) => f.fileName)
            .slice(0, IMPORT_GRAPH_LIMITS.importsPerFile);
    } catch {
        // A file the scanner cannot read has no imports: the graph only loses an edge.
        return [];
    }
}

/**
 * Every path of the tree: the reader's whole-tree call, else listings breadth
 * first from the changed files' directories and the root, a level at a time
 * and in parallel, to a bound of directories and the call's deadline.
 */
async function treeOf(reader: RepoReader, changed: string[], deadline: number, spend: Spend): Promise<string[]> {
    if (reader.paths) {
        try {
            spend.calls++;
            return (await reader.paths()).slice(0, IMPORT_GRAPH_LIMITS.treePaths);
        } catch {
            // Fall through to listings, which throw when none of them answers.
        }
    }
    const out: string[] = [];
    const seen = new Set<string>();
    let level = [...new Set(['', ...changed.map(dirOf)])];
    let listed = 0;
    let failures = 0;
    while (level.length && listed < IMPORT_GRAPH_LIMITS.listDirs && Date.now() < deadline && spend.callsLeft > 0) {
        const next: string[] = [];
        const todo = level.filter((d) => !seen.has(d)).slice(0, IMPORT_GRAPH_LIMITS.listDirs - listed);
        for (let i = 0; i < todo.length && Date.now() < deadline && spend.callsLeft > 0; i += IMPORT_GRAPH_LIMITS.parallel) {
            const chunk = todo.slice(i, i + Math.min(IMPORT_GRAPH_LIMITS.parallel, spend.callsLeft));
            chunk.forEach((d) => seen.add(d));
            listed += chunk.length;
            spend.calls += chunk.length;
            const listings = await Promise.all(chunk.map((d) => reader.list(d).catch(() => (failures++, [] as string[]))));
            chunk.forEach((dir, k) => {
                for (const e of listings[k]) {
                    const full = dir ? `${dir}/${e}` : e;
                    if (e.endsWith('/')) {
                        const d = full.replace(/\/+$/, '');
                        if (!SKIPPED_DIR.test(`${d}/`) && !seen.has(d)) next.push(d);
                    } else if (out.length < IMPORT_GRAPH_LIMITS.treePaths) out.push(full);
                }
            });
        }
        level = next;
    }
    // Nothing listed and every listing failed: the reader cannot list this tree.
    if (!out.length && failures) throw new Error('the tree could not be listed');
    return out;
}

async function contextOf(reader: RepoReader, paths: string[], files: Set<string>, spend: Spend): Promise<ResolveContext> {
    const configs = paths.filter((p) => CONFIG_FILE.test(p) && !SKIPPED_DIR.test(p)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    // A reader of many files at once gets the configs the loop below reads first in one call; a config one of them
    // extends is read on its own.
    const prefetched = reader.readMany ? await readAll(reader, configs.slice(0, IMPORT_GRAPH_LIMITS.configReads), spend) : new Map<string, string | null>();
    const texts = new Map<string, string | null>();
    const read = async (p: string) => {
        if (texts.has(p)) return texts.get(p)!;
        if (texts.size >= IMPORT_GRAPH_LIMITS.configReads) return null;
        texts.set(p, null);
        // An unreadable config resolves no alias: imports through it stay unresolved, never invented.
        const t = prefetched.has(p) ? prefetched.get(p)! : spend.callsLeft > 0 ? (spend.calls++, await reader.read(p, IMPORT_GRAPH_LIMITS.fileBytes).catch(() => null)) : null;
        texts.set(p, t);
        return t;
    };
    const aliases: PathAliases[] = [];
    const packages: WorkspacePackage[] = [];
    for (const p of configs) {
        if (texts.size >= IMPORT_GRAPH_LIMITS.configReads) break;
        if (p.endsWith('package.json')) {
            const text = await read(p);
            const pkg = text === null ? undefined : packageOf(p, text);
            if (pkg) packages.push(pkg);
        } else {
            const a = await aliasesOf(p, read);
            if (a) aliases.push(a);
        }
    }
    return { files, aliases, packages };
}

async function commitGraph(reader: RepoReader, changed: string[], spend: Spend): Promise<CommitGraph | undefined> {
    const paths = await treeOf(reader, changed, Date.now() + IMPORT_GRAPH_LIMITS.millis, spend);
    if (!paths.length) return undefined;
    const files = new Set(paths);
    return { paths, files, ctx: await contextOf(reader, paths, files, spend), nodes: new Map() };
}

/** The node of a file read, scanned for imports and routes; the scan's bytes are counted, and the event loop gets a turn between files. */
async function scannedNodeOf(path: string, text: string | null, g: CommitGraph, spend: Spend): Promise<GraphNode | null> {
    const node = nodeOf(path, text, g);
    await spend.scan(text?.length ?? 0);
    return node;
}

function nodeOf(path: string, text: string | null, g: CommitGraph): GraphNode | null {
    if (text === null) return null;
    const imports = importsOf(text)
        .map((s) => resolveSpecifier(s, path, g.ctx))
        .filter((f): f is string => f !== undefined && f !== path);
    return { imports: [...new Set(imports)], routes: routesOf(path, text, g.files) };
}

/** Directory distance: steps up from one directory to their common ancestor, then down to the other. */
function distance(a: string[], b: string[]): number {
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common++;
    return a.length - common + (b.length - common);
}

/** Importers of each file, among the nodes known. */
function reverseEdges(nodes: Map<string, GraphNode | null>): Map<string, string[]> {
    const rev = new Map<string, string[]>();
    for (const [from, node] of nodes) {
        if (!node || !isGraphFile(from)) continue;
        for (const to of node.imports) {
            const list = rev.get(to);
            if (list) list.push(from);
            else rev.set(to, [from]);
        }
    }
    return rev;
}

/** Breadth first from `start` over importers, stopping at files that declare routes; the routes found, nearest first. */
function walk(start: string, nodes: Map<string, GraphNode | null>, rev: Map<string, string[]>): { routes: ReachedRoute[]; reached: string[] } {
    const own = nodes.get(start)?.routes ?? [];
    if (own.length) return { routes: own.map((route) => ({ route, file: start, hops: 0 })), reached: [] };
    const routes: ReachedRoute[] = [];
    const seen = new Set([start]);
    let frontier = [start];
    for (let hops = 1; hops <= IMPORT_GRAPH_LIMITS.depth && frontier.length && seen.size < IMPORT_GRAPH_LIMITS.nodes; hops++) {
        const next: string[] = [];
        for (const f of frontier) {
            for (const importer of (rev.get(f) ?? []).sort()) {
                if (seen.has(importer) || seen.size >= IMPORT_GRAPH_LIMITS.nodes) continue;
                seen.add(importer);
                const node = nodes.get(importer);
                const declared = node?.routes ?? [];
                if (declared.length && hops > 1 && node!.imports.length >= IMPORT_GRAPH_LIMITS.hubImports) continue;
                if (declared.length) declared.forEach((route) => routes.push({ route, file: importer, hops }));
                else next.push(importer);
            }
        }
        frontier = next;
    }
    return { routes, reached: [...seen] };
}

/**
 * The routes that reach each of `targets` (default: the changed files) through
 * the files that import it, nearest first; a target with no route found is
 * left out, so an empty answer changes nothing in the plan. Changed files are
 * read at `head` when given (a changed file may add the import), the rest at
 * `base`. Never throws: a tree it cannot list answers {}.
 */
export async function routesReaching(
    source: { base: RepoReader; head?: RepoReader; cacheKey?: string; cache?: ImportGraphCache; signal?: AbortSignal; budget?: ImportGraphBudget },
    changedPaths: readonly string[],
    targets: readonly string[] = changedPaths,
): Promise<Record<string, ReachedRoute[]>> {
    const wanted = targets.filter(isGraphFile);
    if (!wanted.length) return {};
    try {
        const cache = source.cache ?? sharedCache;
        const spend = new Spend(importGraphCallsOf(source.budget));
        let pending = source.cacheKey ? cache.get(source.cacheKey) : undefined;
        if (pending === undefined) {
            pending = commitGraph(source.base, [...changedPaths], spend);
            if (source.cacheKey) cache.set(source.cacheKey, pending);
        }
        // No graph adds no route, so the plan is unchanged and the file stays unmapped (never settled).
        const g = await pending.catch(() => undefined);
        if (!g) {
            if (source.cacheKey) cache.delete(source.cacheKey);
            return {};
        }
        return await reach(source, g, changedPaths, wanted, spend);
    } catch {
        // Same fail-safe as an unlistable tree: {} leaves the prompt and the unmapped files as they were.
        return {};
    }
}

async function reach(
    source: { base: RepoReader; head?: RepoReader; signal?: AbortSignal; budget?: ImportGraphBudget },
    g: CommitGraph,
    changedPaths: readonly string[],
    wanted: string[],
    spend: Spend,
): Promise<Record<string, ReachedRoute[]>> {
    const started = Date.now();
    const maxReads = importGraphReadsOf(source.budget);
    const outOfTime = () => Date.now() - started > IMPORT_GRAPH_LIMITS.millis || source.signal?.aborted === true;
    const changed = new Set(changedPaths.filter(isGraphFile));
    // The changed files as the PR has them; the base graph never stores them.
    const nodes = new Map(g.nodes);
    const files = new Set(g.files);
    changed.forEach((f) => files.add(f));
    const view: CommitGraph = { ...g, files, ctx: { ...g.ctx, files } };
    const reader = source.head ?? source.base;
    // An unreadable changed file (or one past the call bound) is a null node: it reaches no route and stays unmapped.
    const changedTexts = outOfTime() ? new Map<string, string | null>() : await readAll(reader, [...changed], spend);
    for (const [f, text] of changedTexts) nodes.set(f, await scannedNodeOf(f, text, view, spend));

    const candidates = g.paths.filter((p) => isGraphFile(p) && !changed.has(p));
    const dirSegs = new Map<string, string[]>();
    const segsOf = (d: string) => dirSegs.get(d) ?? (dirSegs.set(d, d ? d.split('/') : []), dirSegs.get(d)!);
    let reads = 0;
    while (reads < maxReads && !outOfTime() && spend.callsLeft > 0 && spend.scanLeft > 0) {
        // Read next the unread files nearest what the walk has reached so far (routes-looking files first).
        const rev = reverseEdges(nodes);
        const reached = new Set<string>();
        let unresolved = 0;
        for (const t of wanted) {
            const w = walk(t, nodes, rev);
            w.reached.forEach((f) => reached.add(f));
            if (!w.routes.length) unresolved++;
        }
        // Every target already reaches a route: the nearest ones are known, more reads would only add farther ones.
        if (!unresolved) break;
        wanted.forEach((t) => reached.add(t));
        const targetDirs = [...new Set([...reached].map(dirOf))].slice(0, 200).map(segsOf);
        const unread = candidates.filter((p) => !nodes.has(p));
        if (!unread.length) break;
        const score = new Map<string, number>();
        for (const d of new Set(unread.map(dirOf))) {
            const s = segsOf(d);
            score.set(d, Math.min(...targetDirs.map((t) => distance(s, t))));
        }
        const rank = (p: string) => score.get(dirOf(p))! - (ROUTE_LIKE.test(p) ? 3 : 0);
        const batch = unread
            .map((p) => [p, rank(p)] as const)
            .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
            .slice(0, Math.min(IMPORT_GRAPH_LIMITS.batch, maxReads - reads))
            .map(([p]) => p);
        // A reader of many files at once reads the whole batch in one call; else one call a file, a few at a time,
        // the clock checked between them.
        const step = source.base.readMany ? batch.length : IMPORT_GRAPH_LIMITS.parallel;
        for (let i = 0; i < batch.length && !outOfTime() && spend.callsLeft > 0 && spend.scanLeft > 0; i += step) {
            const texts = await readAll(source.base, batch.slice(i, i + step), spend);
            reads += texts.size;
            for (const [p, text] of texts) {
                // An unreadable file is a null node: one importer fewer, never a route made up.
                const node = await scannedNodeOf(p, text, g, spend);
                nodes.set(p, node);
                g.nodes.set(p, node);
            }
        }
    }

    const rev = reverseEdges(nodes);
    const out: Record<string, ReachedRoute[]> = {};
    for (const t of wanted) {
        const routes = walk(t, nodes, rev).routes.slice(0, IMPORT_GRAPH_LIMITS.routesPerFile);
        if (routes.length) out[t] = routes;
    }
    return out;
}
