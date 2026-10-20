/**
 * The finder's repository tools behind Claude Code's interface (#2113, A10):
 * `Read`, `Grep` and `Glob`, with Claude Code's names, parameters and defaults,
 * over the same sandbox (`remoteCommands`) and the same path rules as
 * `agent-tools.factory.ts`.
 *
 * Why: the runs that found 57–66 goldens used Claude Code's own tools, which
 * read whole files (up to 2000 lines) and search with ripgrep's modes; ours
 * steer to small windows (`agent-tools.factory.ts` grep/readFile). This shape
 * is one arm of the eval matrix (T35); the matrix decides which shape Claude
 * gets.
 */
import { jsonSchema } from 'ai';

import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';

/** Claude Code's `Read` default and per-line cap. */
export const CC_READ_DEFAULT_LIMIT = 2000;
export const CC_READ_MAX_LINE_LENGTH = 2000;
/** Bound on what one call returns, like the other sandbox tools (a model reads it all). */
export const CC_MAX_OUTPUT = 60_000;
export const CC_GLOB_MAX_FILES = 100;

function tool(description: string, schema: Record<string, unknown>, execute: (args: any) => Promise<string>) {
    return { type: 'function' as const, description, inputSchema: jsonSchema(schema as any), execute };
}

/**
 * A repository path as the other sandbox tools take it: leading slashes are
 * dropped (paths are relative to the checkout) and `..` is refused.
 */
export function repoPath(raw: unknown): { ok: boolean; path?: string; error?: string } {
    const rel = String(raw ?? '').trim().replace(/^\/+/, '') || '.';
    if (rel.split('/').includes('..')) return { ok: false, error: 'Path traversal using ".." is not allowed' };
    return { ok: true, path: rel };
}

/** The path argument for rg. Always explicit: with none and no TTY, rg reads stdin. */
function searchRoot(path: string): string {
    return ` -- ${shSingleQuote(path)}`;
}

/** rg prefixes `./` when searching the root; paths are relative to the repository. */
function relative(output: string): string {
    return output.replace(/^\.\//gm, '');
}

function cap(text: string): string {
    if (text.length <= CC_MAX_OUTPUT) return text;
    const head = text.slice(0, CC_MAX_OUTPUT);
    return `${head.slice(0, Math.max(head.lastIndexOf('\n'), 0))}\n... (output truncated — narrow the search)`;
}

/** `cat -n` numbering, as Claude Code's Read returns it. */
export function catN(content: string, firstLine: number): string {
    return content
        .split('\n')
        .map((line, i) => `${String(firstLine + i).padStart(6, ' ')}\t${line.length > CC_READ_MAX_LINE_LENGTH ? `${line.slice(0, CC_READ_MAX_LINE_LENGTH)}… (line truncated)` : line}`)
        .join('\n');
}

export function buildClaudeCodeTools(remote: RemoteCommands | undefined): Record<string, any> {
    if (!remote) return {};

    const Read = tool(
        'Reads a file from the repository under review. By default it reads up to 2000 lines from the beginning of the file; ' +
            'pass offset and limit to read a specific part of a long file. Results are returned with line numbers (cat -n format). ' +
            'Paths are relative to the repository root.',
        {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'The path of the file to read, relative to the repository root' },
                offset: { type: 'number', description: 'The line number to start reading from. Only provide if the file is too large to read at once' },
                limit: { type: 'number', description: 'The number of lines to read. Only provide if the file is too large to read at once.' },
            },
            required: ['file_path'],
        },
        async (args) => {
            const p = repoPath(args.file_path ?? args.path);
            if (!p.ok) return `Error: ${p.error}`;
            if (p.path === '.') return 'Error: file_path is required';
            const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
            const limit = Math.max(1, Math.floor(Number(args.limit) || CC_READ_DEFAULT_LIMIT));
            let content: string;
            try {
                content = await remote.read(p.path, offset, offset + limit - 1);
            } catch (err) {
                return `Error reading ${p.path}: ${err instanceof Error ? err.message : String(err)}`;
            }
            if (content === '') {
                return offset > 1 ? `<system-reminder>${p.path} has fewer than ${offset} lines.</system-reminder>` : `<system-reminder>${p.path} exists but is empty.</system-reminder>`;
            }
            return cap(catN(content.replace(/\n$/, ''), offset));
        },
    );

    const Grep = tool(
        'A search tool built on ripgrep. Supports full regex syntax; filter files with glob (e.g. "*.ts") or type (e.g. "py"). ' +
            'output_mode: "content" shows matching lines, "files_with_matches" (default) shows file paths, "count" shows match counts. ' +
            'Use -A/-B/-C for context lines and -i for case-insensitive search (content mode). multiline: true lets a pattern span lines.',
        {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The regular expression pattern to search for in file contents' },
                path: { type: 'string', description: 'File or directory to search in, relative to the repository root. Defaults to the repository root.' },
                glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")' },
                output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'], description: 'Output mode. Defaults to "files_with_matches".' },
                '-B': { type: 'number', description: 'Lines to show before each match (content mode)' },
                '-A': { type: 'number', description: 'Lines to show after each match (content mode)' },
                '-C': { type: 'number', description: 'Lines to show before and after each match (content mode)' },
                '-n': { type: 'boolean', description: 'Show line numbers (content mode). Defaults to true.' },
                '-i': { type: 'boolean', description: 'Case insensitive search' },
                type: { type: 'string', description: 'File type to search (rg --type), e.g. js, py, rust, go, java' },
                head_limit: { type: 'number', description: 'Limit output to the first N lines/entries' },
                multiline: { type: 'boolean', description: 'Enable multiline mode where . matches newlines and patterns can span lines. Default: false.' },
            },
            required: ['pattern'],
        },
        async (args) => {
            const pattern = String(args.pattern ?? '');
            if (!pattern) return 'Error: pattern is required';
            const p = repoPath(args.path);
            if (!p.ok) return `Error: ${p.error}`;
            if (!remote.exec) {
                const out = await remote.grep(pattern, p.path, args.glob);
                return cap(out || 'No matches found');
            }
            const mode = args.output_mode === 'content' || args.output_mode === 'count' ? args.output_mode : 'files_with_matches';
            const flags: string[] = [];
            if (mode === 'files_with_matches') flags.push('-l');
            else if (mode === 'count') flags.push('-c');
            else {
                if (args['-n'] !== false) flags.push('-n');
                for (const k of ['-A', '-B', '-C'] as const) {
                    const n = Number(args[k]);
                    if (Number.isFinite(n) && n > 0) flags.push(`${k} ${Math.floor(n)}`);
                }
            }
            if (args['-i']) flags.push('-i');
            if (args.multiline) flags.push('-U', '--multiline-dotall');
            if (args.glob) flags.push(`--glob ${shSingleQuote(String(args.glob))}`);
            if (args.type) flags.push(`--type ${shSingleQuote(String(args.type))}`);
            // `-e` and `--`: a pattern or path starting with "-" is never read as an rg flag.
            const cmd = `rg ${flags.join(' ')} -e ${shSingleQuote(pattern)}${searchRoot(p.path)}`;
            const { stdout, stderr, exitCode } = await remote.exec(cmd);
            if (exitCode >= 2) return `Error: ${(stderr || 'ripgrep failed').trim()}`;
            if (exitCode === 1 || !stdout.trim()) return 'No matches found';
            let lines = relative(stdout).replace(/\n$/, '').split('\n');
            const limit = Math.floor(Number(args.head_limit));
            if (Number.isFinite(limit) && limit > 0) lines = lines.slice(0, limit);
            const body = lines.join('\n');
            return cap(mode === 'files_with_matches' ? `Found ${lines.length} file${lines.length === 1 ? '' : 's'}\n${body}` : body);
        },
    );

    const Glob = tool(
        'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths. ' +
            'Use it to find files by name pattern.',
        {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The glob pattern to match files against' },
                path: { type: 'string', description: 'The directory to search in, relative to the repository root. Defaults to the repository root.' },
            },
            required: ['pattern'],
        },
        async (args) => {
            const pattern = String(args.pattern ?? '');
            if (!pattern) return 'Error: pattern is required';
            const p = repoPath(args.path);
            if (!p.ok) return `Error: ${p.error}`;
            if (!remote.exec) return 'Error: file search is not available in this sandbox';
            const { stdout, stderr, exitCode } = await remote.exec(`rg --files --glob ${shSingleQuote(pattern)}${searchRoot(p.path)}`);
            if (exitCode >= 2) return `Error: ${(stderr || 'file search failed').trim()}`;
            const files = relative(stdout).split('\n').filter(Boolean).sort();
            if (!files.length) return 'No files found';
            const shown = files.slice(0, CC_GLOB_MAX_FILES).join('\n');
            return files.length > CC_GLOB_MAX_FILES ? `${shown}\n(Results are truncated. Consider using a more specific path or pattern.)` : shown;
        },
    );

    return { Read, Grep, Glob };
}
