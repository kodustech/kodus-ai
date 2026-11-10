import { posix } from 'path';

import { redactPatterns } from '@libs/runtime/redaction';

import { isSecretFile, type RepoReader, repoPath } from './repo-reader';

// search_code of the test planner (ADR-069): a bounded, literal grep over the
// repository at one commit, read through the RepoReader (the Git API in
// production). Nothing is executed and no pattern is compiled from model
// text, so a search cannot hang on a pathological regex.

export const SEARCH_LIMITS = {
    /** Searches in one run. */
    searches: 8,
    /** Files one search reads; it says when there were more candidates. */
    filesPerSearch: 80,
    /** Paths one search walks to find candidates. */
    candidates: 3_000,
    /** Directories one walk lists. */
    dirs: 400,
    /** Bytes of one file the search reads. */
    fileBytes: 256 * 1024,
    /** Matching lines one search returns: every one is re-sent on each later step of the round. */
    matches: 25,
    lineChars: 200,
    minText: 3,
    maxText: 200,
    /** Files read in parallel. */
    parallel: 8,
} as const;

/** Paths a search never reads: secret files, generated or vendored trees, binaries. */
const SKIPPED_DIR = /(^|\/)(node_modules|vendor|dist|build|\.git|\.next|coverage|target|__pycache__)\//;
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|pdf|zip|gz|tgz|bz2|xz|tar|jar|war|class|so|dylib|dll|exe|bin|wasm|woff2?|ttf|eot|otf|mp[34]|mov|avi|lock|sum|min\.js|map)$/i;

export const isSearchable = (path: string) => !isSecretFile(path) && !SKIPPED_DIR.test(`${path}`) && !BINARY.test(path);

export interface SearchQuery {
    text: string;
    /** A directory to search under; absent: the changed files' directories first, then the root. */
    path?: string;
    ignoreCase?: boolean;
}

export interface SearchOutcome {
    matches: string[];
    scanned: number;
    /** Candidates past the per-search bound, not read. */
    skipped: number;
}

/**
 * The files a search reads, nearest first: under `path` when given, else the
 * directories of the changed files (the code that registers a changed
 * handler is usually next to it), then the rest of the tree, breadth first.
 */
export async function searchCandidates(reader: RepoReader, roots: string[]): Promise<string[]> {
    const out: string[] = [];
    const seenDirs = new Set<string>();
    const seenFiles = new Set<string>();
    const queue = [...roots];
    let listed = 0;
    while (queue.length && out.length < SEARCH_LIMITS.candidates && listed < SEARCH_LIMITS.dirs) {
        const dir = queue.shift()!;
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        listed++;
        const entries = await reader.list(dir);
        const subdirs: string[] = [];
        for (const e of entries) {
            const full = dir ? `${dir}/${e}` : e;
            if (e.endsWith('/')) subdirs.push(full.replace(/\/+$/, ''));
            else if (!seenFiles.has(full) && isSearchable(full)) {
                seenFiles.add(full);
                out.push(full);
            }
        }
        for (const d of subdirs) if (!SKIPPED_DIR.test(`${d}/`)) queue.push(d);
    }
    return out.slice(0, SEARCH_LIMITS.candidates);
}

/** The directories a search without `path` starts from: each changed file's, then the root. */
export function searchRoots(changedPaths: string[]): string[] {
    const dirs = changedPaths.map((p) => posix.dirname(p)).map((d) => (d === '.' ? '' : d));
    return [...new Set([...dirs, ''])];
}

/** Runs one literal search; the reader's failures reach the caller. */
export async function searchCode(reader: RepoReader, query: SearchQuery, changedPaths: string[], cache: Map<string, string | null>): Promise<SearchOutcome> {
    const roots = query.path !== undefined && query.path !== '' ? [repoPath(query.path, { dir: true })] : searchRoots(changedPaths);
    const candidates = await searchCandidates(reader, roots);
    const files = candidates.slice(0, SEARCH_LIMITS.filesPerSearch);
    const needle = query.ignoreCase ? query.text.toLowerCase() : query.text;
    const matches: string[] = [];
    let scanned = 0;
    for (let i = 0; i < files.length && matches.length < SEARCH_LIMITS.matches; i += SEARCH_LIMITS.parallel) {
        const batch = files.slice(i, i + SEARCH_LIMITS.parallel);
        scanned += batch.length;
        const texts = await Promise.all(
            batch.map(async (f) => {
                if (!cache.has(f)) cache.set(f, await reader.read(f, SEARCH_LIMITS.fileBytes));
                return cache.get(f) ?? null;
            }),
        );
        for (const [j, text] of texts.entries()) {
            if (text === null) continue;
            const lines = text.split('\n');
            for (const [n, line] of lines.entries()) {
                if (matches.length >= SEARCH_LIMITS.matches) break;
                if ((query.ignoreCase ? line.toLowerCase() : line).includes(needle)) {
                    // Each line shown is redacted like a read (S-51).
                    matches.push(`${batch[j]}:${n + 1}: ${redactPatterns(line.trim().slice(0, SEARCH_LIMITS.lineChars)).text}`);
                }
            }
        }
    }
    return { matches, scanned, skipped: candidates.length - scanned };
}
