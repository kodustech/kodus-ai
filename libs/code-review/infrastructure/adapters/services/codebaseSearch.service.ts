import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { RemoteCommands } from './collectCrossFileContexts.service';

//#region Types
export const CODEBASE_SEARCH_SERVICE_TOKEN = Symbol('CodebaseSearchService');

export interface CodebaseSearchInput {
    /** Ripgrep-compatible regex pattern */
    query: string;
    /** Remote command executors (grep, read, listDir) from E2B sandbox */
    remoteCommands: RemoteCommands;
    /** Glob patterns to include (e.g. ["**\/*.ts"]). Only the first is passed to grep; rest are post-filtered. */
    includes?: string[];
    /** Glob patterns or path prefixes to exclude (e.g. ["node_modules", ".git"]) */
    excludes?: string[];
    /** Lines of context around each match (default: 40) */
    contextLines?: number;
    /** Maximum number of files to return (default: 20) */
    maxFiles?: number;
    /** Maximum matches per file before merging (default: 5) */
    maxMatchesPerFile?: number;
}

export interface CodebaseSearchContext {
    file: string;
    content: string;
    lines: [number, number][];
}

export interface CodebaseSearchResult {
    success: boolean;
    contexts: CodebaseSearchContext[];
    error?: string;
}

interface GrepMatch {
    file: string;
    line: number;
    text: string;
}
//#endregion

//#region Constants
const DEFAULT_CONTEXT_LINES = 40;
const DEFAULT_MAX_FILES = 20;
const DEFAULT_MAX_MATCHES_PER_FILE = 5;
const MERGE_GAP = 10;
//#endregion

@Injectable()
export class CodebaseSearchService {
    private readonly logger = createLogger(CodebaseSearchService.name);

    /**
     * Searches a codebase using ripgrep via remote commands.
     * Deterministic: grep → parse → merge ranges → read context → return.
     */
    async search(input: CodebaseSearchInput): Promise<CodebaseSearchResult> {
        const {
            query,
            remoteCommands,
            includes,
            excludes,
            contextLines = DEFAULT_CONTEXT_LINES,
            maxFiles = DEFAULT_MAX_FILES,
            maxMatchesPerFile = DEFAULT_MAX_MATCHES_PER_FILE,
        } = input;

        if (!query) {
            return { success: false, contexts: [], error: 'Empty query' };
        }

        try {
            // 1. Execute grep
            const glob = includes?.[0];
            let raw: string;

            this.logger.log({
                message: `[DEBUG] codebaseSearch.grep starting: query="${query}" path="." glob="${glob ?? 'none'}"`,
                context: CodebaseSearchService.name,
            });

            try {
                raw = await remoteCommands.grep(query, '.', glob);
            } catch (error) {
                // rg exits with code 1 when no matches found — not an error
                const message =
                    error instanceof Error ? error.message : String(error);

                this.logger.log({
                    message: `[DEBUG] codebaseSearch.grep threw for query="${query}": ${message.slice(0, 300)}`,
                    context: CodebaseSearchService.name,
                });

                // Auth/fatal errors (git clone failures, network issues) must always
                // surface as failures — they would otherwise corrupt downstream reviews.
                // Check these BEFORE the "exit 1" branch because messages like
                // "exit code 128" contain "exit code 1" as a substring.
                if (this.isFatalErrorOutput(message)) {
                    this.logger.error({
                        message: `codebaseSearch.grep failed with fatal/auth error: ${message.slice(0, 300)}`,
                        context: CodebaseSearchService.name,
                    });
                    return { success: false, contexts: [], error: message };
                }

                if (this.isRipgrepNoMatches(message)) {
                    return { success: true, contexts: [] };
                }
                return { success: false, contexts: [], error: message };
            }

            this.logger.log({
                message: `[DEBUG] codebaseSearch.grep returned for query="${query}": ${raw ? raw.length + ' chars, ' + raw.trim().split('\n').length + ' lines' : 'EMPTY'}`,
                context: CodebaseSearchService.name,
                metadata: { rawPreview: raw?.slice(0, 300) },
            });

            if (!raw || !raw.trim()) {
                return { success: true, contexts: [] };
            }

            // The E2B sandbox layer sometimes swallows non-zero exit codes and
            // returns stderr as the resolved value instead of throwing. Detect
            // auth/fatal failures in the raw output so we do not silently parse
            // them into an empty match list.
            if (
                this.isFatalErrorOutput(raw) &&
                !this.looksLikeRipgrepOutput(raw)
            ) {
                this.logger.error({
                    message: `codebaseSearch.grep returned fatal/auth error as output: ${raw.slice(0, 300)}`,
                    context: CodebaseSearchService.name,
                });
                return { success: false, contexts: [], error: raw };
            }

            // 2. Parse rg output
            const matches = this.parseGrepOutput(raw);

            // 3. Filter by excludes
            const filtered = excludes?.length
                ? matches.filter(
                      (m) =>
                          !excludes.some((ex) =>
                              this.matchesExclude(m.file, ex),
                          ),
                  )
                : matches;

            if (!filtered.length) {
                return { success: true, contexts: [] };
            }

            // 4. Group by file, cap files and matches per file
            const grouped = this.groupByFile(
                filtered,
                maxFiles,
                maxMatchesPerFile,
            );

            // 5. Merge nearby ranges per file
            const fileRanges = this.mergeRanges(grouped);

            // 6. Read context for each range
            const contexts = await this.readContexts(
                fileRanges,
                remoteCommands,
                contextLines,
            );

            return { success: true, contexts };
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            this.logger.error({
                message: `Codebase search failed for query "${query}": ${message}`,
                context: CodebaseSearchService.name,
                error,
            });
            return { success: false, contexts: [], error: message };
        }
    }

    /**
     * Returns true when the output comes from ripgrep reporting no matches.
     * Uses word-boundary matching so it does not accidentally classify
     * "exit code 128" (auth failure) as "exit code 1" (no matches).
     */
    private isRipgrepNoMatches(output: string): boolean {
        return (
            /\bexit (code|status) 1\b/.test(output) ||
            /\bexited with code 1\b/.test(output) ||
            output.includes('No matches')
        );
    }

    /**
     * Returns true when the output contains a git/network/auth fatal error
     * that must always surface as a failure (never be treated as "no matches").
     */
    private isFatalErrorOutput(output: string): boolean {
        return (
            /fatal:/i.test(output) ||
            /authentication failed/i.test(output) ||
            /could not read username/i.test(output) ||
            /permission denied/i.test(output) ||
            /\bexit (code|status) 128\b/.test(output)
        );
    }

    /**
     * Heuristic to decide whether a string looks like real ripgrep output
     * (at least one `file:line:text` row) rather than an error message.
     */
    private looksLikeRipgrepOutput(raw: string): boolean {
        return raw
            .split('\n')
            .some((line) => /^[^:\n]+:\d+:/.test(line));
    }

    /**
     * Parses ripgrep output lines into structured matches.
     * rg format: "file:lineNum:matched text"
     */
    parseGrepOutput(raw: string): GrepMatch[] {
        const matches: GrepMatch[] = [];
        const lines = raw.split('\n');

        for (const line of lines) {
            if (!line.trim()) continue;

            // Split on first two colons: file:line:content
            const firstColon = line.indexOf(':');
            if (firstColon === -1) continue;

            const secondColon = line.indexOf(':', firstColon + 1);
            if (secondColon === -1) continue;

            const file = line.substring(0, firstColon);
            const lineNum = parseInt(
                line.substring(firstColon + 1, secondColon),
                10,
            );
            const text = line.substring(secondColon + 1);

            if (!file || isNaN(lineNum)) continue;

            matches.push({ file, line: lineNum, text });
        }

        return matches;
    }

    /**
     * Groups matches by file path, caps the number of files and matches per file.
     * Files with more matches are prioritized.
     */
    private groupByFile(
        matches: GrepMatch[],
        maxFiles: number,
        maxMatchesPerFile: number,
    ): Map<string, GrepMatch[]> {
        const byFile = new Map<string, GrepMatch[]>();

        for (const match of matches) {
            const existing = byFile.get(match.file) || [];
            existing.push(match);
            byFile.set(match.file, existing);
        }

        // Sort files by match count (descending) and cap
        const sorted = [...byFile.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, maxFiles);

        const result = new Map<string, GrepMatch[]>();
        for (const [file, fileMatches] of sorted) {
            result.set(file, fileMatches.slice(0, maxMatchesPerFile));
        }

        return result;
    }

    /**
     * Merges nearby line matches into contiguous ranges.
     * Matches within MERGE_GAP lines of each other become one range.
     */
    mergeRanges(
        grouped: Map<string, GrepMatch[]>,
    ): Map<string, [number, number][]> {
        const result = new Map<string, [number, number][]>();

        for (const [file, matches] of grouped) {
            const sortedLines = matches
                .map((m) => m.line)
                .sort((a, b) => a - b);

            const ranges: [number, number][] = [];
            let rangeStart = sortedLines[0];
            let rangeEnd = sortedLines[0];

            for (let i = 1; i < sortedLines.length; i++) {
                if (sortedLines[i] - rangeEnd <= MERGE_GAP) {
                    rangeEnd = sortedLines[i];
                } else {
                    ranges.push([rangeStart, rangeEnd]);
                    rangeStart = sortedLines[i];
                    rangeEnd = sortedLines[i];
                }
            }
            ranges.push([rangeStart, rangeEnd]);

            result.set(file, ranges);
        }

        return result;
    }

    /**
     * Reads expanded context for each range from the sandbox.
     */
    private async readContexts(
        fileRanges: Map<string, [number, number][]>,
        remoteCommands: RemoteCommands,
        contextLines: number,
    ): Promise<CodebaseSearchContext[]> {
        const tasks: { file: string; start: number; end: number }[] = [];
        for (const [file, ranges] of fileRanges) {
            for (const [start, end] of ranges) {
                tasks.push({ file, start, end });
            }
        }

        const results = await Promise.allSettled(
            tasks.map(async ({ file, start, end }) => {
                const readStart = Math.max(1, start - contextLines);
                const readEnd = end + contextLines;
                const content = await remoteCommands.read(
                    file,
                    readStart,
                    readEnd,
                );

                if (content && content.trim()) {
                    return {
                        file,
                        content,
                        lines: [[start, end]],
                    } as CodebaseSearchContext;
                }
                return null;
            }),
        );

        return results.reduce<CodebaseSearchContext[]>((acc, result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                acc.push(result.value);
            } else if (result.status === 'rejected') {
                const { file, start, end } = tasks[index];
                this.logger.warn({
                    message: `Failed to read context for ${file}:${start}-${end}`,
                    context: CodebaseSearchService.name,
                    error: result.reason,
                });
            }
            return acc;
        }, []);
    }

    /**
     * Checks if a file path matches an exclude pattern.
     * Supports:
     *   - Directory segments: "node_modules" matches "libs/node_modules/foo.ts"
     *   - Extension globs: "*.min.js" matches "libs/bundle.min.js"
     *   - Path prefixes: "test/" matches "test/unit/foo.ts"
     */
    private matchesExclude(filePath: string, exclude: string): boolean {
        // Extension glob: *.ext
        if (exclude.startsWith('*.')) {
            return filePath.endsWith(exclude.slice(1));
        }

        // Path prefix with trailing slash: "test/" matches "test/unit/foo.ts"
        if (exclude.endsWith('/')) {
            const segments = filePath.split('/');
            return segments.some((_, i) =>
                segments
                    .slice(0, i + 1)
                    .join('/')
                    .startsWith(exclude.slice(0, -1)),
            );
        }

        // Directory segment: "node_modules" matches as a path segment, not substring
        // "test" matches "test/foo.ts" or "src/test/foo.ts" but NOT "attest.ts"
        const segments = filePath.split('/');
        return segments.some((seg) => seg === exclude);
    }
}
