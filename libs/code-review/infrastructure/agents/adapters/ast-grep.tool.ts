/**
 * code-review (domain) — `astGrep`, the structural search tool offered to
 * custom review agents.
 *
 * Two modes:
 *  - pattern: an ad-hoc ast-grep pattern + language over the repository (or
 *    the paths the model names). Always offered to a custom agent.
 *  - rules: the agent's rule file (`tools.astGrepConfig`) over the changed
 *    files. Offered only when the agent has one. The rules are read from the
 *    PR TARGET branch through `readTargetFile` and written to a temp path, so a
 *    pull request cannot rewrite the rules it is judged by.
 *
 * Every run passes `--config` pointing at a neutral, empty sgconfig this tool
 * writes. Without it ast-grep discovers the checkout's own `sgconfig.yml`, and
 * a `customLanguages` entry there makes it load a shared library from the
 * pull request — code execution chosen by the author.
 *
 * The command is built as argv and each argument single-quoted before it goes
 * through the sandbox's hardened `exec`; no rewrite flag (`-U`/`--update-all`)
 * or symlink follower is ever emitted, and user-supplied values are passed as
 * `--flag=value` and after `--`, so none can be read as a flag.
 */
import type { AgentTool } from '@libs/agent-harness/domain/contracts/tool.contract';
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { CUSTOM_AGENT_LIMITS } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { createLogger } from '@libs/core/log/logger';

const logger = createLogger('AstGrepTool');

export const AST_GREP_TOOL_NAME = 'astGrep';
export const MAX_AST_GREP_MATCHES = 50;
/** A rule file is a handful of YAML documents; anything this large is not
 *  one. The same limit refuses such rules on save. */
export const MAX_AST_GREP_RULE_BYTES = CUSTOM_AGENT_LIMITS.maxAstGrepRuleBytes;
const MAX_PATTERN_LENGTH = 2_000;
const MAX_PATHS = 20;
const MAX_MATCH_TEXT = 200;
const MAX_STDERR = 500;
const NEUTRAL_CONFIG = 'ruleDirs: []\n';
const LANGUAGE = /^[A-Za-z][A-Za-z0-9+#_]{0,19}$/;

export interface AstGrepToolDeps {
    /** The sandbox's hardened exec (cwd = repository root). */
    exec: NonNullable<RemoteCommands['exec']>;
    /** Writes a file at a repository-relative path inside the sandbox. */
    writeFile: (repoRelativePath: string, content: string) => Promise<void>;
    /** Changed files of the PR (repository-relative), scanned in rules mode. */
    changedFiles: readonly string[];
    /** The agent's `tools.astGrepConfig`: repository path of the rule file. */
    rulesPath?: string;
    /** Rule YAML saved on the agent itself; wins over `rulesPath`. */
    rules?: string;
    /** Reads a file from the PR target branch; null when it is not there. */
    readTargetFile?: (path: string) => Promise<string | null>;
    /** Temp directory name; random per run unless a test pins it. */
    workDirName?: string;
    /** Review identifiers (organization, team, repository, PR, agent) for logs. */
    logContext?: Record<string, unknown>;
}

export interface AstGrepInput {
    pattern?: string;
    language?: string;
    paths?: string[];
    useRules?: boolean;
}

interface ParsedMatch {
    file: string;
    line: number;
    column: number;
    text: string;
    ruleId?: string;
    message?: string;
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isSafeRepoPath(value: unknown): value is string {
    if (typeof value !== 'string' || !value.trim()) return false;
    if (value.length > 500 || /[\0\n\r]/.test(value)) return false;
    if (value.startsWith('-') || value.startsWith('/')) return false;
    if (/^[A-Za-z]:[\\/]/.test(value)) return false;
    return !/(^|[/\\])\.\.($|[/\\])/.test(value);
}

function parseStream(stdout: string): ParsedMatch[] {
    const matches: ParsedMatch[] = [];
    for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let raw: any;
        try {
            raw = JSON.parse(trimmed);
        } catch {
            // The exec caps its buffer, so the last line can be cut short.
            continue;
        }
        if (!raw || typeof raw.file !== 'string') continue;
        const start = raw.range?.start ?? {};
        matches.push({
            file: raw.file,
            line: Number(start.line ?? 0) + 1,
            column: Number(start.column ?? 0) + 1,
            text: String(raw.text ?? ''),
            ruleId: typeof raw.ruleId === 'string' ? raw.ruleId : undefined,
            message:
                typeof raw.message === 'string' && raw.message
                    ? raw.message
                    : undefined,
        });
    }
    return matches;
}

function formatMatches(matches: ParsedMatch[], header: string): string {
    const shown = matches.slice(0, MAX_AST_GREP_MATCHES);
    const lines = [
        `${matches.length} ${matches.length === 1 ? 'match' : 'matches'} ${header}:`,
    ];
    for (const m of shown) {
        const rule = m.ruleId
            ? ` [${m.ruleId}]${m.message ? ` ${m.message}` : ''}`
            : '';
        const firstLine = m.text.split('\n')[0];
        const text =
            firstLine.length > MAX_MATCH_TEXT
                ? `${firstLine.slice(0, MAX_MATCH_TEXT)}…`
                : firstLine;
        lines.push(`${m.file}:${m.line}:${m.column}${rule}`, `  ${text}`);
    }
    const hidden = matches.length - shown.length;
    if (hidden > 0) {
        lines.push(
            `... ${hidden} more not shown; narrow the pattern or paths.`,
        );
    }
    return lines.join('\n');
}

/** How a finding backed by a rule match must be reported for the match to
 *  stand as its proof (`astGrepRuleIdOf` / `isProvenByAstGrep`). */
const RULE_CITATION =
    'Report a finding backed by a rule match with kind "convention", the matched file and line, and source.file "ast-grep:<ruleId>" (the id in brackets) with the rule\'s message as source.quote. A match cited that way is proof on its own and needs no further check.';

/** The citation of each rule that matched, so the model copies it exactly. */
function formatRuleCitations(matches: ParsedMatch[]): string {
    const messages = new Map<string, string | undefined>();
    for (const m of matches) {
        if (m.ruleId && !messages.has(m.ruleId)) {
            messages.set(m.ruleId, m.message);
        }
    }
    if (messages.size === 0) return '';
    const lines = [...messages].map(
        ([id, message]) =>
            `- ${id}: kind "convention", source.file "ast-grep:${id}"${message ? `, source.quote ${JSON.stringify(message)}` : ''}`,
    );
    return `\n\n${RULE_CITATION}\n${lines.join('\n')}`;
}

function randomWorkDir(): string {
    return `.kody-ast-grep-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}

export function buildAstGrepTool(
    deps: AstGrepToolDeps,
): AgentTool<AstGrepInput> {
    const workDir = deps.workDirName ?? randomWorkDir();
    const configPath = `${workDir}/sgconfig.yml`;
    const rulesFile = `${workDir}/rules.yml`;
    const hasRules =
        !!deps.rules?.trim() || (!!deps.rulesPath && !!deps.readTargetFile);

    // Written once per run; a failed write is retried on the next call.
    let configReady: Promise<void> | null = null;
    const ensureConfig = (): Promise<void> => {
        if (!configReady) {
            configReady = deps
                .writeFile(configPath, NEUTRAL_CONFIG)
                .catch((error) => {
                    configReady = null;
                    throw error;
                });
        }
        return configReady;
    };

    let rulesReady: Promise<void> | null = null;
    const ensureRules = (): Promise<void> => {
        if (!rulesReady) {
            rulesReady = (async () => {
                const source = deps.rules?.trim()
                    ? 'The rules saved on the agent'
                    : `Rule file ${deps.rulesPath}`;
                const text = deps.rules?.trim()
                    ? deps.rules
                    : await deps.readTargetFile!(deps.rulesPath!);
                if (text === null || text === undefined || !text.trim()) {
                    throw new Error(
                        `${source} was not found on the target branch.`,
                    );
                }
                if (Buffer.byteLength(text, 'utf8') > MAX_AST_GREP_RULE_BYTES) {
                    throw new Error(
                        `${source} are larger than ${MAX_AST_GREP_RULE_BYTES} bytes.`,
                    );
                }
                await deps.writeFile(rulesFile, text);
            })().catch((error) => {
                rulesReady = null;
                throw error;
            });
        }
        return rulesReady;
    };

    const properties: Record<string, any> = {
        pattern: {
            type: 'string',
            description:
                'ast-grep pattern, e.g. `$DB.query($SQL)` or `useEffect($FN)`. `$X` matches one node, `$$$X` any number.',
        },
        language: {
            type: 'string',
            description:
                'Language of the pattern: typescript, tsx, javascript, python, go, java, kotlin, rust, ruby, php, csharp, ...',
        },
        paths: {
            type: 'array',
            items: { type: 'string' },
            description:
                'Repository-relative files or directories to search. Omit to search the whole repository.',
        },
    };
    if (hasRules) {
        properties.useRules = {
            type: 'boolean',
            description:
                "true runs the team's ast-grep rules over the changed files (pattern/language are ignored). A rule match is evidence on its own.",
        };
    }

    const description =
        'Structural code search with ast-grep: matches syntax, not text, so it ignores formatting, comments and strings. ' +
        'Give a pattern and its language to find every place a construct appears.' +
        (hasRules
            ? ` Set useRules to run the team's ast-grep rules over the changed files. ${RULE_CITATION}`
            : '');

    const run = async (
        argv: string[],
        mode: 'pattern' | 'rules',
        header: string,
    ) => {
        const result = await deps.exec(argv.map(shellQuote).join(' '));
        const matches = parseStream(result.stdout ?? '');
        const stderr = (result.stderr ?? '').trim().slice(0, MAX_STDERR);

        // 0 = matches, 1 = no match (also used when a path is missing);
        // anything else, or an `Error:` with nothing parsed, is a failure.
        if (
            matches.length === 0 &&
            (result.exitCode > 1 || /^\s*error/im.test(stderr))
        ) {
            return {
                output: `ast-grep failed (exit ${result.exitCode}): ${stderr || 'no output'}`,
                isError: true,
                meta: { mode, matches: 0 },
            };
        }
        if (matches.length === 0) {
            return {
                output: `No matches ${header}.`,
                meta: { mode, matches: 0 },
            };
        }
        const notes = stderr ? `\n\nast-grep warnings: ${stderr}` : '';
        const citations = mode === 'rules' ? formatRuleCitations(matches) : '';
        return {
            output: formatMatches(matches, header) + citations + notes,
            meta: { mode, matches: matches.length },
        };
    };

    return {
        name: AST_GREP_TOOL_NAME,
        description,
        inputSchema: { type: 'object', properties },
        async execute(input) {
            const args = input ?? {};
            try {
                if (args.useRules) {
                    if (!hasRules) {
                        return {
                            output: 'This agent has no ast-grep rule file configured; search with a pattern instead.',
                            isError: true,
                        };
                    }
                    const files = deps.changedFiles.filter(isSafeRepoPath);
                    if (files.length === 0) {
                        return { output: 'No changed files to scan.' };
                    }
                    await ensureConfig();
                    await ensureRules();
                    return await run(
                        [
                            'ast-grep',
                            'scan',
                            `--config=${configPath}`,
                            `--rule=${rulesFile}`,
                            '--json=stream',
                            '--',
                            ...files,
                        ],
                        'rules',
                        `for the rules in ${deps.rulesPath} (target branch) over the changed files`,
                    );
                }

                const pattern =
                    typeof args.pattern === 'string' ? args.pattern : '';
                if (!pattern.trim() || pattern.length > MAX_PATTERN_LENGTH) {
                    return {
                        output: `A pattern of 1 to ${MAX_PATTERN_LENGTH} characters is required.`,
                        isError: true,
                    };
                }
                const language =
                    typeof args.language === 'string' ? args.language : '';
                if (!LANGUAGE.test(language)) {
                    return {
                        output: 'A language name such as typescript, python or go is required.',
                        isError: true,
                    };
                }
                const paths = args.paths?.length ? args.paths : ['.'];
                if (
                    !Array.isArray(paths) ||
                    paths.length > MAX_PATHS ||
                    !paths.every(isSafeRepoPath)
                ) {
                    return {
                        output: `Each path must be repository-relative (no "..", no leading "/" or "-"), at most ${MAX_PATHS}.`,
                        isError: true,
                    };
                }

                await ensureConfig();
                return await run(
                    [
                        'ast-grep',
                        'run',
                        `--config=${configPath}`,
                        `--pattern=${pattern}`,
                        `--lang=${language}`,
                        '--json=stream',
                        '--',
                        ...paths,
                    ],
                    'pattern',
                    `for the pattern`,
                );
            } catch (error) {
                // The rules and pattern stay out of the log: only the mode.
                logger.warn({
                    message: 'astGrep failed',
                    context: 'astGrepTool',
                    error,
                    metadata: {
                        mode: args.useRules ? 'rules' : 'pattern',
                        ...deps.logContext,
                    },
                });
                return {
                    output: `astGrep failed: ${error instanceof Error ? error.message : String(error)}`,
                    isError: true,
                };
            }
        },
    };
}
