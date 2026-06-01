import { jsonSchema } from 'ai';
import * as path from 'node:path';
import { createLogger } from '@kodus/flow';
import { RemoteCommands } from '../../adapters/services/collectCrossFileContexts.service';

const logger = createLogger('AgentTools');

export const MAX_GREP_MATCHES = 50;
export const MAX_READ_LENGTH = 8_000;
export const MAX_LIST_LENGTH = 4_000;
export const MAX_SHELL_OUTPUT = 10_000;

/** Cap on docs returned per searchDocs call to keep tool output bounded. */
const MAX_DOCS_OUTPUT_LENGTH = 6_000;

/**
 * Minimal interface for the documentation search capability.
 * Avoids importing DocumentationSearchExaService directly so the factory
 * does not pull exa-js into call sites that don't need it.
 */
export interface DocumentationSearchAdapter {
    searchByFilePlan(
        planByFile: Record<
            string,
            { queryTasks: Array<{ packageName: string; query: string }> }
        >,
        options?: Record<string, unknown>,
    ): Promise<
        Record<
            string,
            Array<{
                query: string;
                title: string;
                url: string;
                snippet: string;
                source: string;
            }>
        >
    >;
}

/**
 * Create a tool definition compatible with all AI SDK providers (including Anthropic).
 *
 * Uses `type: 'function'` + `inputSchema` with raw JSON Schema instead of Zod,
 * because Zod v4 + zod-to-json-schema is broken — it generates empty schemas
 * that Anthropic API rejects with "input_schema.type: Field required".
 */
function mkTool(
    desc: string,
    schema: Record<string, any>,
    exec: (args: any) => Promise<string>,
) {
    return {
        type: 'function' as const,
        description: desc,
        inputSchema: jsonSchema(schema),
        execute: exec,
    };
}

function addLineNumbers(content: string, baseLineNumber: number): string {
    return content
        .split('\n')
        .map((line, i) => `${baseLineNumber + i}: ${line}`)
        .join('\n');
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeRepoPath(value: string): string {
    return value.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '');
}

function truncateShellOutput(output: string): string {
    if (output.length <= MAX_SHELL_OUTPUT) return output;
    return output.substring(0, MAX_SHELL_OUTPUT) + '\n... (truncated)';
}

function filterDiagnosticsToTarget(
    output: string,
    targetPath: string,
    scopePath?: string,
): string {
    const normalizedTarget = normalizeRepoPath(targetPath || '.');
    const targetBase = path.posix.basename(normalizedTarget);
    const targetDir = path.posix.dirname(normalizedTarget);
    const normalizedScope = scopePath ? normalizeRepoPath(scopePath) : '';
    const scopeDir = normalizedScope ? path.posix.dirname(normalizedScope) : '';

    const markers = [
        normalizedTarget,
        targetBase,
        targetDir !== '.' ? `${targetDir}/` : '',
        scopeDir && scopeDir !== '.' ? `${scopeDir}/` : '',
    ].filter(Boolean);

    const lines = output.split('\n');
    const keep = new Set<number>();

    for (let i = 0; i < lines.length; i++) {
        if (!markers.some((marker) => lines[i].includes(marker))) {
            continue;
        }

        keep.add(i);
        if (i > 0) keep.add(i - 1);
        if (i + 1 < lines.length) keep.add(i + 1);
    }

    if (keep.size === 0) return '';

    return Array.from(keep)
        .sort((a, b) => a - b)
        .map((index) => lines[index])
        .join('\n')
        .trim();
}

/**
 * Build the tool set for the agent from RemoteCommands.
 *
 * When `remoteCommands` is undefined (e.g. trial mode or sandbox
 * unavailable), returns an empty tool set. The agent loop detects the
 * empty case and switches to a self-contained analysis variant.
 */
export function buildAgentTools(
    remoteCommands: RemoteCommands | undefined,
    gitHubToken?: string,
    repositoryFullName?: string,
    documentationSearchService?: DocumentationSearchAdapter,
    documentationSearchOptions?: Record<string, unknown>,
): Record<string, any> {
    if (!remoteCommands) {
        return {};
    }
    const tools: Record<string, any> = {
        grep: mkTool(
            'DISCOVERY tool: search the repo for a pattern. Returns "file:line:content" with context. ' +
                'Use grep BEFORE readFile to locate what you need — never read a whole file to find something. ' +
                'Common patterns: grep("methodName\\(") for callers, grep("CONSTANT") for usages, grep("implements X") for implementations, ' +
                'grep("if.*err.*!=.*nil") to check error handling, grep("lock\\|mutex\\|synchronized") to check concurrency. ' +
                'After finding a match, use readFile(file, startLine=line-15, endLine=line+30) for surgical context. ' +
                'Use namesOnly=true for blast-radius (which files are affected). ' +
                'Use excludeTests=true to focus on production code.',
            {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description:
                            'Regex pattern to search for. To find callers of a method, use "methodName\\(" (escaping the parenthesis). To find usages of a constant, use the constant name.',
                    },
                    glob: {
                        type: 'string',
                        description:
                            'Optional glob to filter files (e.g. "*.ts", "*.java")',
                    },
                    path: {
                        type: 'string',
                        description: 'Optional directory to scope the search',
                    },
                    namesOnly: {
                        type: 'boolean',
                        description:
                            'Return only file paths instead of matching lines. Useful for blast-radius checks.',
                    },
                    excludeTests: {
                        type: 'boolean',
                        description:
                            'Exclude test and spec files from results. Use this when tracing production callers to avoid noise from test fixtures.',
                    },
                },
                required: ['pattern'],
            },
            async (args: any) => {
                const pattern = args.pattern || args.regex || '';
                const glob = args.glob || args.include || undefined;
                const searchPath =
                    (args.path || args.directory || args.dir || '.').replace(
                        /^\/+/,
                        '',
                    ) || '.';
                const namesOnly = args.namesOnly ?? false;
                const excludeTests = args.excludeTests ?? false;
                if (!pattern) return 'Error: pattern is required';

                // Use rg directly in sandbox for richer output (-n, -C 5)
                if (remoteCommands.exec) {
                    try {
                        const safePattern = pattern.replace(/'/g, "'\\''");
                        const safePath = searchPath.replace(/'/g, "'\\''");
                        const safeGlob = glob ? glob.replace(/'/g, "'\\''") : '';
                        const globArg = safeGlob ? ` --glob '${safeGlob}'` : '';
                        const excludeTestsArgs = excludeTests
                            ? ` --glob '!*test*' --glob '!*Test*' --glob '!*spec*' --glob '!*Spec*' --glob '!*__tests__*'`
                            : '';
                        const modeArg = namesOnly ? ' -l' : ' -n -C 5';
                        const cmd = `rg '${safePattern}'${globArg}${excludeTestsArgs}${modeArg} '${safePath}'`;
                        const { stdout, exitCode } =
                            await remoteCommands.exec(cmd);
                        // exit code 1 with "not allowed" = blocked by sandbox, fall through to fallback
                        if (exitCode === 1 && stdout.includes('not allowed')) {
                            throw new Error('rg blocked by sandbox');
                        }
                        // exit code 1 = no matches (not an error)
                        if (exitCode === 1 || !stdout.trim())
                            return 'No matches found.';
                        if (exitCode === 0) {
                            const raw = stdout.trim();
                            const lines = raw.split('\n');
                            if (namesOnly) {
                                return lines
                                    .slice(0, MAX_GREP_MATCHES)
                                    .join('\n');
                            }

                            if (lines.length > MAX_GREP_MATCHES) {
                                return (
                                    lines
                                        .slice(0, MAX_GREP_MATCHES)
                                        .join('\n') +
                                    `\n... (${lines.length - MAX_GREP_MATCHES} more lines)`
                                );
                            }
                            return stdout.trim();
                        }
                    } catch {
                        // rg not available, fall through to remoteCommands.grep
                    }
                }

                // Fallback: remoteCommands.grep (no context lines)
                let result: string;
                try {
                    result = await remoteCommands.grep(
                        pattern,
                        searchPath,
                        glob,
                    );
                } catch (err) {
                    return `Error searching for "${pattern}": ${err instanceof Error ? err.message : String(err)}`;
                }
                if (namesOnly) {
                    const files = [
                        ...new Set(
                            result
                                .split('\n')
                                .map((line) => line.split(':')[0])
                                .filter(Boolean),
                        ),
                    ];
                    return files.slice(0, MAX_GREP_MATCHES).join('\n');
                }
                const lines = result.split('\n');
                if (lines.length > MAX_GREP_MATCHES) {
                    result =
                        lines.slice(0, MAX_GREP_MATCHES).join('\n') +
                        `\n... (${lines.length - MAX_GREP_MATCHES} more matches)`;
                }
                return result;
            },
        ),

        readFile: mkTool(
            'Read file contents with injected line numbers. Always use startLine/endLine from grep results or diff @@ markers. ' +
                'Rule of thumb: readFile(file, startLine=grepLine-20, endLine=grepLine+30) gives enough context to understand a caller. ' +
                'Only read the full file when it is small (<150 lines). Never read a whole file to find a method — grep first. ' +
                'Before each read, know the exact unanswered question this range will answer. ' +
                'Do not reread highly overlapping ranges of the same file just to gain confidence; only do it when a new symbol, caller/callee, or branch requires one more targeted read.',
            {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'File path relative to repo root',
                    },
                    startLine: {
                        type: 'number',
                        description:
                            'Start line (1-based). Use this to read around the changed lines (e.g. 50 lines before/after the diff)',
                    },
                    endLine: {
                        type: 'number',
                        description: 'End line (1-based)',
                    },
                },
                required: ['path'],
            },
            async (args: any) => {
                // Tolerate models sending file/filePath instead of path
                let filePath: string =
                    args.path || args.filePath || args.file || '';
                const startLine = args.startLine || args.start_line || 0;
                const endLine = args.endLine || args.end_line || 0;
                // Strip leading slash — paths are relative to repo root
                filePath = filePath.replace(/^\/+/, '');
                if (!filePath) return 'Error: path is required';
                let result: string;
                try {
                    result = await remoteCommands.read(
                        filePath,
                        startLine,
                        endLine,
                    );
                } catch (err) {
                    return `Error reading ${filePath}: ${err instanceof Error ? err.message : String(err)}`;
                }
                if (!result && result !== '') {
                    return `Error: readFile returned ${typeof result} for ${filePath}`;
                }
                const baseLineNumber = startLine > 0 ? startLine : 1;
                result = addLineNumbers(result, baseLineNumber);
                if (result.length > MAX_READ_LENGTH) {
                    const lines = result.split('\n');
                    result =
                        result.substring(0, MAX_READ_LENGTH) +
                        `\n... (truncated — file has ~${lines.length} lines, call readFile again with startLine/endLine to read the rest)`;
                }
                return result;
            },
        ),

        listDir: mkTool(
            'List files and directories. Use maxDepth to control recursion (default 2).',
            {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Directory path (default: ".")',
                    },
                    maxDepth: {
                        type: 'number',
                        description: 'Max recursion depth (default: 2, max: 4)',
                    },
                },
            },
            async (args: any) => {
                const dirPath =
                    (args.path || args.directory || args.dir || '.').replace(
                        /^\/+/,
                        '',
                    ) || '.';
                const depth = Math.min(args.maxDepth || args.max_depth || 2, 4);
                let result = await remoteCommands.listDir(dirPath, depth);
                // Filter out common noise directories
                const IGNORE_DIRS = [
                    'node_modules',
                    '.git',
                    'dist',
                    'build',
                    '.next',
                    '__pycache__',
                    'coverage',
                    '.turbo',
                    'vendor',
                    '.cache',
                ];
                result = result
                    .split('\n')
                    .filter(
                        (line) =>
                            !IGNORE_DIRS.some((dir) => line.includes(dir)),
                    )
                    .join('\n');
                if (result.length > MAX_LIST_LENGTH) {
                    result =
                        result.substring(0, MAX_LIST_LENGTH) +
                        `\n... (truncated)`;
                }
                return result;
            },
        ),

        findFile: mkTool(
            'Find files by name or glob pattern. Use this to locate files before reading them.',
            {
                type: 'object',
                properties: {
                    pattern: {
                        type: 'string',
                        description:
                            'File name or glob pattern (e.g. "config.ts", "*.test.go", "schema")',
                    },
                    path: {
                        type: 'string',
                        description: 'Directory to search in (default: ".")',
                    },
                    extension: {
                        type: 'string',
                        description:
                            'Filter by extension (e.g. "ts", "go", "rb")',
                    },
                },
                required: ['pattern'],
            },
            async (args: any) => {
                const pattern = args.pattern || '';
                if (!pattern) return 'Error: pattern is required';
                const searchPath =
                    (args.path || '.').replace(/^\/+/, '') || '.';
                const ext = args.extension || args.ext || '';
                const safePattern = pattern.replace(/'/g, "'\\''");
                const safePath = searchPath.replace(/'/g, "'\\''");
                const safeExt = ext ? ext.replace(/'/g, "'\\''") : '';
                const extArg = safeExt ? ` -e '${safeExt}'` : '';

                try {
                    // Try fd first (fast, .gitignore aware), then find as fallback
                    if (remoteCommands.exec) {
                        // Try fd with --glob for precise matching
                        try {
                            const globPattern =
                                safePattern.includes('*') ||
                                safePattern.includes('?')
                                    ? safePattern
                                    : `*${safePattern}*`;
                            const fdCmd = `fd --glob '${globPattern}'${extArg} '${safePath}' --type f --max-results 30`;
                            const { stdout } = await remoteCommands.exec(fdCmd);
                            if (stdout && stdout.trim()) return stdout.trim();
                        } catch {
                            // fd not available, try find
                        }
                        // Fallback to find — keep wildcards the user passed in;
                        // `-iname` understands `*` and `?` natively, so stripping
                        // them would break any glob search (e.g. `*.ts` would
                        // match foo.tsx and foo.ts.bak). Only wrap with `*…*`
                        // when the pattern has no wildcards at all, mirroring
                        // the fd path above.
                        try {
                            const globPattern =
                                safePattern.includes('*') ||
                                safePattern.includes('?')
                                    ? safePattern
                                    : `*${safePattern}*`;
                            const findCmd = `find '${safePath}' -type f -iname '${globPattern}'`;
                            const { stdout } =
                                await remoteCommands.exec(findCmd);
                            if (stdout && stdout.trim()) {
                                const lines = stdout.trim().split('\n');
                                return lines.slice(0, 30).join('\n');
                            }
                        } catch {
                            // find also failed, fall through to listDir
                        }
                    }

                    // Fallback: listDir + filter (slower, no .gitignore)
                    const allFiles = await remoteCommands.listDir(
                        searchPath,
                        4,
                    );
                    const matching = allFiles
                        .split('\n')
                        .filter(
                            (f: string) =>
                                f.trim() &&
                                f
                                    .toLowerCase()
                                    .includes(pattern.toLowerCase()) &&
                                (!ext || f.endsWith(`.${ext}`)),
                        );
                    if (matching.length === 0)
                        return `No files matching "${pattern}" in ${searchPath}`;
                    if (matching.length > 30) {
                        return (
                            matching.slice(0, 30).join('\n') +
                            `\n... (${matching.length - 30} more files)`
                        );
                    }
                    return matching.join('\n');
                } catch (err) {
                    return `Error finding files: ${err instanceof Error ? err.message : String(err)}`;
                }
            },
        ),
    };

    // Add exec-based tools if available
    if (remoteCommands.exec) {
        const exec = remoteCommands.exec;

        const findNearestProjectFile = async (
            targetPath: string,
            exactNames: string[] = [],
            globPattern?: string,
        ): Promise<string | null> => {
            const normalizedTarget = normalizeRepoPath(targetPath || '.');
            const exactChecks = exactNames
                .map(
                    (name) =>
                        `if [ -f "$dir/${name}" ]; then printf '%s\\n' "$dir/${name}"; exit 0; fi`,
                )
                .join('\n');
            const globCheck = globPattern
                ? `
match=$(find "$dir" -maxdepth 1 -type f -name ${shellQuote(globPattern)} | sort | head -1)
if [ -n "$match" ]; then printf '%s\\n' "$match"; exit 0; fi`
                : '';

            const script = `
target=${shellQuote(normalizedTarget || '.')}
if [ -f "$target" ]; then
  dir=$(dirname "$target")
else
  dir="$target"
fi
while true; do
${exactChecks}
${globCheck}
  if [ "$dir" = "." ] || [ "$dir" = "/" ]; then
    break
  fi
  next=$(dirname "$dir")
  if [ "$next" = "$dir" ]; then
    break
  fi
  dir="$next"
done
${exactNames
    .map(
        (name) =>
            `if [ -f ${shellQuote(name)} ]; then printf '%s\\n' ${shellQuote(name)}; exit 0; fi`,
    )
    .join('\n')}
`;

            try {
                const { stdout } = await exec(script);
                return stdout?.trim() || null;
            } catch {
                return null;
            }
        };

        const collectTargetFiles = async (
            targetPath: string,
            extension: string,
            maxFiles: number,
        ): Promise<string[]> => {
            const normalizedTarget = normalizeRepoPath(targetPath || '.');
            const safeTarget = shellQuote(normalizedTarget || '.');
            const safePattern = shellQuote(`*${extension}`);
            const script = `
target=${safeTarget}
if [ -f "$target" ]; then
  printf '%s\\n' "$target"
else
  find "$target" -maxdepth 3 -type f -name ${safePattern} 2>/dev/null | head -${maxFiles}
fi
`;

            try {
                const { stdout } = await exec(script);
                return stdout
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean);
            } catch {
                return [];
            }
        };

        tools.checkTypes = mkTool(
            'Run a local type checker, compiler, or linter for a file or directory. Auto-detects language and scopes ' +
                'checks to the nearest package/project when possible (for example nearest tsconfig, go.mod, Cargo.toml, or .csproj). ' +
                'Use this to confirm concrete type errors, compile errors, wiring issues, and import problems.',
            {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description:
                            'File or directory to check (default: entire repo). Example: "src/api/paginator.py"',
                    },
                },
            },
            async (args: any) => {
                const target = normalizeRepoPath(args.path || '.') || '.';
                const safeTarget = shellQuote(target);

                // Detect which languages exist
                let fileList: string;
                try {
                    const { stdout } = await exec(
                        `[ -f ${safeTarget} ] && printf '%s\\n' ${safeTarget} || find ${safeTarget} -maxdepth 3 -type f 2>/dev/null | head -50`,
                    );
                    fileList = stdout;
                } catch {
                    return 'Could not scan files in target path.';
                }

                const results: string[] = [];

                const pushScopedResult = (
                    lang: string,
                    scope: string,
                    rawOutput: string,
                ) => {
                    const output = rawOutput?.trim();
                    if (
                        !output ||
                        output.includes('command not found') ||
                        output.includes('not found')
                    ) {
                        return;
                    }

                    const filteredOutput = filterDiagnosticsToTarget(
                        output,
                        target,
                        scope,
                    );
                    if (filteredOutput) {
                        results.push(
                            truncateShellOutput(
                                `[${lang} — scope: ${scope}]\n${filteredOutput}`,
                            ),
                        );
                        return;
                    }

                    results.push(
                        `[${lang} — scope: ${scope}]\nNo diagnostics matched ${target}; omitted unrelated diagnostics outside this local scope.`,
                    );
                };

                if (fileList.includes('.py')) {
                    const files = await collectTargetFiles(target, '.py', 10);
                    if (files.length > 0) {
                        const quotedFiles = files.map(shellQuote).join(' ');
                        try {
                            const { stdout } = await exec(
                                `python3 -m py_compile ${quotedFiles} 2>&1`,
                            );
                            pushScopedResult('Python', target, stdout);
                        } catch {
                            // py_compile not available, skip
                        }
                        try {
                            const { stdout } = await exec(
                                `mypy ${safeTarget} --no-error-summary --no-color 2>&1 | head -30`,
                            );
                            pushScopedResult('Python', target, stdout);
                        } catch {
                            // mypy not available, skip
                        }
                    }
                }

                if (fileList.includes('.go')) {
                    const scopeDir = target.endsWith('.go')
                        ? path.posix.dirname(target)
                        : target || '.';
                    const packageScope =
                        scopeDir && scopeDir !== '.' ? `./${scopeDir}` : '.';
                    for (const cmd of [
                        `go vet ${shellQuote(packageScope)} 2>&1 | head -30`,
                        `go build -o /dev/null ${shellQuote(packageScope)} 2>&1 | head -30`,
                    ]) {
                        try {
                            const { stdout } = await exec(cmd);
                            pushScopedResult('Go', packageScope, stdout);
                        } catch {
                            // go tool not available, skip
                        }
                    }
                }

                if (fileList.includes('.ts')) {
                    const tsconfig =
                        (await findNearestProjectFile(target, [
                            'tsconfig.json',
                        ])) ||
                        (await findNearestProjectFile(
                            target,
                            [],
                            'tsconfig*.json',
                        ));

                    try {
                        const { stdout } = await exec(
                            tsconfig
                                ? `npx tsc --noEmit -p ${shellQuote(tsconfig)} 2>&1 | head -40`
                                : `npx tsc --noEmit --pretty false ${safeTarget} 2>&1 | head -40`,
                        );
                        pushScopedResult(
                            'TypeScript',
                            tsconfig || target,
                            stdout,
                        );
                    } catch {
                        // tsc not available, skip
                    }
                }

                if (fileList.includes('.rb')) {
                    const files = await collectTargetFiles(target, '.rb', 10);
                    if (files.length > 0) {
                        try {
                            const { stdout } = await exec(
                                `ruby -c ${files
                                    .map(shellQuote)
                                    .join(
                                        ' ',
                                    )} 2>&1 | grep -v "Syntax OK" | head -20`,
                            );
                            pushScopedResult('Ruby', target, stdout);
                        } catch {
                            // ruby not available, skip
                        }
                    }
                }

                if (fileList.includes('.php')) {
                    const files = await collectTargetFiles(target, '.php', 10);
                    if (files.length > 0) {
                        try {
                            const { stdout } = await exec(
                                `php -l ${files
                                    .map(shellQuote)
                                    .join(
                                        ' ',
                                    )} 2>&1 | grep -v "No syntax errors" | head -20`,
                            );
                            pushScopedResult('PHP', target, stdout);
                        } catch {
                            // php not available, skip
                        }
                    }
                }

                if (fileList.includes('.dart')) {
                    try {
                        const { stdout } = await exec(
                            `dart analyze ${safeTarget} 2>&1 | head -30`,
                        );
                        pushScopedResult('Dart', target, stdout);
                    } catch {
                        // dart not available, skip
                    }
                }

                if (fileList.includes('.rs')) {
                    const cargoToml = await findNearestProjectFile(target, [
                        'Cargo.toml',
                    ]);
                    if (cargoToml) {
                        try {
                            const { stdout } = await exec(
                                `cargo check --manifest-path ${shellQuote(cargoToml)} 2>&1 | head -30`,
                            );
                            pushScopedResult('Rust', cargoToml, stdout);
                        } catch {
                            // cargo not available, skip
                        }
                    }
                }

                if (fileList.includes('.cs')) {
                    const projectFile =
                        (await findNearestProjectFile(
                            target,
                            [],
                            '*.csproj',
                        )) ||
                        (await findNearestProjectFile(target, [], '*.sln'));
                    if (projectFile) {
                        try {
                            const { stdout } = await exec(
                                `dotnet build ${shellQuote(projectFile)} --no-restore 2>&1 | grep -E "error|warning" | head -30`,
                            );
                            pushScopedResult('C#', projectFile, stdout);
                        } catch {
                            // dotnet not available, skip
                        }
                    }
                }

                if (fileList.includes('.java')) {
                    const files = await collectTargetFiles(target, '.java', 5);
                    if (files.length > 0) {
                        try {
                            const { stdout } = await exec(
                                `javac -d /tmp/javaout ${files
                                    .map(shellQuote)
                                    .join(' ')} 2>&1 | head -30`,
                            );
                            pushScopedResult('Java', target, stdout);
                        } catch {
                            // javac not available, skip
                        }
                    }
                }

                if (fileList.includes('.kt')) {
                    const files = await collectTargetFiles(target, '.kt', 5);
                    if (files.length > 0) {
                        try {
                            const { stdout } = await exec(
                                `kotlinc ${files
                                    .map(shellQuote)
                                    .join(
                                        ' ',
                                    )} -d /tmp/kotlinc-out.jar 2>&1 | head -20`,
                            );
                            pushScopedResult('Kotlin', target, stdout);
                        } catch {
                            // kotlinc not available, skip
                        }
                    }
                }

                if (fileList.includes('.swift')) {
                    const files = await collectTargetFiles(target, '.swift', 5);
                    if (files.length > 0) {
                        try {
                            const { stdout } = await exec(
                                `swiftc -typecheck ${files
                                    .map(shellQuote)
                                    .join(' ')} 2>&1 | head -20`,
                            );
                            pushScopedResult('Swift', target, stdout);
                        } catch {
                            // swiftc not available, skip
                        }
                    }
                }

                if (results.length === 0) {
                    return 'No type errors or linter issues found (or no supported linter available).';
                }

                return truncateShellOutput(results.join('\n\n'));
            },
        );
    }

    // readReference — cross-repo file reading via GitHub API. Required for
    // kody rules that reference files in other repositories (e.g.
    // `@file:org/design-system/docs/pattern.md`). Sandbox-based `readFile`
    // only sees the current PR's repo, so without this tool the agent has
    // no way to fetch externally-referenced files.
    if (gitHubToken) {
        tools.readReference = mkTool(
            'Read a file from another repository. Use this to fetch reference files mentioned in rules (e.g., coding standards, patterns from other repos). Accepts the full "owner/repo" form and an optional branch.',
            {
                type: 'object',
                properties: {
                    repo: {
                        type: 'string',
                        description:
                            'Full repository name (e.g. "my-org/design-system")',
                    },
                    path: {
                        type: 'string',
                        description:
                            'File path within the repository (e.g. "docs/standards.md")',
                    },
                    branch: {
                        type: 'string',
                        description: 'Branch name (default: main)',
                    },
                },
                required: ['repo', 'path'],
            },
            async ({ repo, path, branch }: any) => {
                if (!repo || !path) return 'Error: repo and path are required';
                const ref = branch || 'main';
                const safePath = encodeURIComponent(path);
                try {
                    const response = await fetch(
                        `https://api.github.com/repos/${repo}/contents/${safePath}?ref=${ref}`,
                        {
                            headers: {
                                Authorization: `Bearer ${gitHubToken}`,
                                Accept: 'application/vnd.github.v3.raw',
                            },
                        },
                    );
                    if (!response.ok) {
                        logger.warn({
                            message: `[READ-REFERENCE] ${repo}#${ref} ${path} → ${response.status} ${response.statusText}`,
                            context: 'agent-tools.readReference',
                        });
                        return `Error: Could not read ${path} from ${repo} (${response.status} ${response.statusText})`;
                    }
                    const content = await response.text();
                    logger.log({
                        message: `[READ-REFERENCE] ${repo}#${ref} ${path} → ok (${content.length} chars)`,
                        context: 'agent-tools.readReference',
                    });
                    if (content.length > MAX_READ_LENGTH) {
                        return (
                            content.substring(0, MAX_READ_LENGTH) +
                            `\n... (truncated — ${content.length} chars total)`
                        );
                    }
                    return content;
                } catch (err) {
                    logger.warn({
                        message: `[READ-REFERENCE] ${repo}#${ref} ${path} → error: ${err instanceof Error ? err.message : String(err)}`,
                        context: 'agent-tools.readReference',
                    });
                    return `Error reading ${path} from ${repo}: ${err instanceof Error ? err.message : String(err)}`;
                }
            },
        );
    }

    // ── Call Graph lookup tool (AST-based) ──────────────────────────
    // DISABLED: getCallers tool — call graph is already injected in the prompt as <CallGraph>.
    // Agent reads callers from context (0 tool calls for getCallers in 170+ runs).
    // Keeping the code for future use if we move call graph out of the prompt.
    // if (false) {
    //     const { loadCallGraphForTool } = require('../call-graph.helper');
    //     const callGraphData = loadCallGraphForTool(repositoryFullName);

    //     if (callGraphData) {
    //         tools.getCallers = mkTool(
    //             'Look up callers of a function from the pre-computed AST call graph. ' +
    //                 'Use this for EVERY changed function to understand impact — who calls it, what breaks if it changes. ' +
    //                 'Returns caller file:line pairs. Then use readFile on each caller to check if the change breaks them. ' +
    //                 'Faster and more accurate than grep for finding callers. Always try this before grep for caller lookup.',
    //             {
    //                 type: 'object',
    //                 properties: {
    //                     functionName: {
    //                         type: 'string',
    //                         description: 'Function or method name to look up callers for',
    //                     },
    //                     filePath: {
    //                         type: 'string',
    //                         description: 'Optional file path to disambiguate (e.g. "src/sentry/api/paginator.py")',
    //                     },
    //                 },
    //                 required: ['functionName'],
    //             },
    //             async (args: { functionName: string; filePath?: string }) => {
    //                 const byShortName = new Map<string, any[]>();
    //                 for (const entry of Object.values(callGraphData) as any[]) {
    //                     const sn = entry.short_name || entry.name;
    //                     const list = byShortName.get(sn) || [];
    //                     list.push(entry);
    //                     byShortName.set(sn, list);
    //                 }

    //                 const candidates = byShortName.get(args.functionName) || [];
    //                 let matches = candidates;

    //                 if (args.filePath) {
    //                     const fileMatch = candidates.filter((c: any) =>
    //                         args.filePath!.endsWith(c.file) || c.file.endsWith(args.filePath!),
    //                     );
    //                     if (fileMatch.length > 0) matches = fileMatch;
    //                 }

    //                 if (matches.length === 0) {
    //                     return `No call graph data found for "${args.functionName}"${args.filePath ? ` in ${args.filePath}` : ''}`;
    //                 }

    //                 const lines: string[] = [];
    //                 for (const entry of matches.slice(0, 3)) {
    //                     const shortFile = entry.file.split('/').slice(-2).join('/');
    //                     lines.push(`${entry.name} (${shortFile}:${entry.line})`);
    //                     if (entry.callers.length === 0) {
    //                         lines.push('  (no production callers found)');
    //                     } else {
    //                         for (const c of entry.callers.slice(0, 8)) {
    //                             const callerShort = c.file.split('/').slice(-2).join('/');
    //                             lines.push(`  ← ${callerShort}:${c.line}${c.name ? ` (${c.name})` : ''}`);
    //                         }
    //                     }
    //                     lines.push('');
    //                 }
    //                 return lines.join('\n');
    //             },
    //         );
    //     }
    // }

    // ── External documentation lookup (Exa) ─────────────────────────
    if (documentationSearchService) {
        tools.searchDocs = mkTool(
            'VERIFY tool: search EXTERNAL package/library documentation when a finding hinges on framework behavior you cannot verify with grep/readFile (e.g. TypeORM subQuery semantics, React Suspense boundaries, Express middleware ordering). ' +
                'Returns official documentation snippets. ' +
                'Use ONLY when:\n' +
                '  - the suspected bug is about how a third-party API behaves\n' +
                '  - you already grepped/read the local code and the answer requires the library spec\n' +
                'Do NOT use for: project-internal code (use grep), generic concepts (use your training), or cosmetic checks. ' +
                'Each call counts against an external rate limit — be deliberate.',
            {
                type: 'object',
                properties: {
                    packageName: {
                        type: 'string',
                        description:
                            'Package/library name as published (e.g. "express", "react", "@nestjs/common", "typeorm")',
                    },
                    query: {
                        type: 'string',
                        description:
                            'Specific question about the library API (e.g. "subQuery returns only first row in left join", "useEffect cleanup on unmount", "middleware error handling order")',
                    },
                },
                required: ['packageName', 'query'],
            },
            async (args: any) => {
                const packageName = (args?.packageName || '').toString().trim();
                const query = (args?.query || '').toString().trim();
                if (!packageName || !query) {
                    return 'Error: both packageName and query are required.';
                }

                try {
                    const planByFile = {
                        agent: { queryTasks: [{ packageName, query }] },
                    };
                    const results =
                        await documentationSearchService.searchByFilePlan(
                            planByFile,
                            documentationSearchOptions,
                        );

                    const docs = results['agent'] || [];
                    if (docs.length === 0) {
                        return `No documentation found for "${packageName}" with query "${query}".`;
                    }

                    const formatted = docs
                        .map(
                            (doc) =>
                                `### ${doc.title}\n**URL:** ${doc.url}\n**Query:** ${doc.query}\n\n${doc.snippet}`,
                        )
                        .join('\n\n---\n\n');

                    if (formatted.length > MAX_DOCS_OUTPUT_LENGTH) {
                        return (
                            formatted.substring(0, MAX_DOCS_OUTPUT_LENGTH) +
                            `\n... (truncated — ${formatted.length} chars total across ${docs.length} doc(s))`
                        );
                    }
                    return formatted;
                } catch (err) {
                    return `Documentation search error: ${
                        err instanceof Error ? err.message : String(err)
                    }`;
                }
            },
        );
    }

    logger.log({
        message: `[AGENT-TOOLS] registered=${Object.keys(tools).join(',')} gitHubToken=${gitHubToken ? 'yes' : 'no'}`,
        context: 'agent-tools.factory',
    });

    return tools;
}
