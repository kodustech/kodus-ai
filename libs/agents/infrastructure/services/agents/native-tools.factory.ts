import { z } from 'zod';

import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { NULL_SANDBOX_INSTANCE } from '@libs/sandbox/infrastructure/providers/null-sandbox.service';
import {
    cutLongLines,
    MAX_TOOL_LINE_CHARS,
} from '@libs/common/utils/tool-output/long-lines';
import {
    isSecretFilePath,
    secretFileRefusal,
    withoutSecretFileLines,
} from '@libs/common/utils/tool-output/secret-files';
import {
    MAX_TOOL_SCAN_CHARS,
    scanPrefix,
} from '@libs/common/utils/tool-output/scan-prefix';
import { beginToolActivity } from '@libs/core/infrastructure/activity/activity-registry';
import { timeSync } from '@libs/core/infrastructure/activity/time-sync';
import { createLogger } from '@libs/core/log/logger';

const logger = createLogger('ConversationTools');

/**
 * Most characters one tool answer hands the conversation agent. Code review
 * tools cap reads at 8k; this agent reads larger ranges, so the cap only
 * stops a runaway answer (a minified bundle, a whole lockfile) from reaching
 * the prompt and the compressor.
 */
export const MAX_CONVERSATION_TOOL_OUTPUT_CHARS = 64_000;

/** Most characters of a tool answer the guards read (see scan-prefix.ts). */
export const MAX_CONVERSATION_TOOL_SCAN_CHARS = MAX_TOOL_SCAN_CHARS;

/**
 * Shape of a legacy flow-engine tool config — locally typed to avoid importing from
 * a non-public path of the package. Matches `ToolConfig` from the SDK at the
 * fields actually consumed by `orchestration.createTool(...)`.
 */
type ToolConfig = {
    name: string;
    description: string;
    inputSchema: z.ZodSchema<unknown>;
    execute: (input: unknown) => Promise<unknown>;
};

/** A tool over the open sandbox's commands, before it is opened for the call. */
type RepositoryTool = Omit<ToolConfig, 'execute'> & {
    execute: (input: unknown, remote: RemoteCommands) => Promise<unknown>;
};

/** What a repository tool answers when the turn has no checkout to read. */
export const REPOSITORY_UNAVAILABLE =
    'The repository checkout could not be opened for this conversation, so grep, readFile, listDir and exec cannot run. Do not call them again in this turn.';

/**
 * Native tools backed by the sandbox `RemoteCommands` contract.
 *
 * The sandbox is opened by the first call, not before the run (#2629): a turn
 * that never reads the repository starts, resumes and fetches nothing.
 * `openSandbox` must hand every call the same sandbox (`openOnFirstUse`), so
 * the parallel first reads of one step share one open.
 *
 * A null sandbox (no provider) or an open that failed answers every call
 * with REPOSITORY_UNAVAILABLE; the agent keeps its MCP tools.
 */
export function buildNativeToolConfigs(
    openSandbox: () => Promise<SandboxInstance>,
): ToolConfig[] {
    // Azure Repos paths start with `/`; the sandbox rejects absolute paths.
    const repoPath = (path: string | undefined) =>
        (path ?? '.').replace(/^\/+/, '') || '.';

    const grepTool: RepositoryTool = {
        name: 'grep',
        description:
            'Search for a regex pattern in the repository. Returns matching lines with file path and line number. Use to find symbols, references, configuration entries, or any text occurrence.',
        inputSchema: z.object({
            pattern: z
                .string()
                .describe('Regex pattern to search for. Case-sensitive.'),
            path: z
                .string()
                .optional()
                .describe(
                    'Optional sub-path to scope the search (relative to repo root). Defaults to the whole repo.',
                ),
            glob: z
                .string()
                .optional()
                .describe(
                    'Optional glob filter (e.g. "*.ts") to restrict file types.',
                ),
        }),
        execute: async (input: unknown, remote: RemoteCommands) => {
            const { pattern, path, glob } = input as {
                pattern: string;
                path?: string;
                glob?: string;
            };
            const result = await remote.grep(pattern, repoPath(path), glob);
            return { matches: result };
        },
    };

    const readFileTool: RepositoryTool = {
        name: 'readFile',
        description:
            'Read a file from the repository between two line numbers (1-indexed, inclusive). Use to inspect implementation details after grep.',
        inputSchema: z.object({
            path: z.string().describe('Repo-relative path to the file.'),
            start: z
                .number()
                .int()
                .min(1)
                .describe('First line to return (1-indexed, inclusive).'),
            end: z
                .number()
                .int()
                .min(1)
                .describe('Last line to return (1-indexed, inclusive).'),
        }),
        execute: async (input: unknown, remote: RemoteCommands) => {
            const { path, start, end } = input as {
                path: string;
                start: number;
                end: number;
            };
            const content = await remote.read(repoPath(path), start, end);
            return { content };
        },
    };

    const listDirTool: RepositoryTool = {
        name: 'listDir',
        description:
            'List files and folders under a directory in the repository, up to a maximum depth. Use to explore unfamiliar projects.',
        inputSchema: z.object({
            path: z.string().describe('Repo-relative directory path.'),
            maxDepth: z
                .number()
                .int()
                .min(1)
                .max(10)
                .default(2)
                .describe('Maximum recursion depth. Default 2.'),
        }),
        execute: async (input: unknown, remote: RemoteCommands) => {
            const { path, maxDepth } = input as {
                path: string;
                maxDepth?: number;
            };
            const listing = await remote.listDir(repoPath(path), maxDepth ?? 2);
            return { listing };
        },
    };

    const execTool: RepositoryTool = {
        name: 'exec',
        description:
            'Run a read-only shell command inside the sandbox. Use sparingly for ad-hoc read-only inspection (git log, cat, etc.).',
        inputSchema: z.object({
            command: z
                .string()
                .describe(
                    'Shell command to run. Must be read-only (no writes, no network calls outside the sandbox).',
                ),
        }),
        execute: async (input: unknown, remote: RemoteCommands) => {
            // Optional on RemoteCommands: both providers implement it, and it
            // cannot be known before the sandbox opens.
            if (typeof remote.exec !== 'function') {
                return { error: 'exec is not available in this checkout.' };
            }
            const { command } = input as { command: string };
            return remote.exec(command);
        },
    };

    return [grepTool, readFileTool, listDirTool, execTool].map((tool) =>
        guardConversationTool({
            ...tool,
            execute: async (input: unknown) => {
                // The opener's caller reports a failed open (the chat logs
                // it, the eval stops on it); the agent only needs to know.
                const sandbox = await openSandbox().catch(
                    () => NULL_SANDBOX_INSTANCE,
                );
                if (sandbox.type === 'null') {
                    return { error: REPOSITORY_UNAVAILABLE };
                }
                return tool.execute(input, sandbox.remoteCommands);
            },
        }),
    );
}

/** Argument fields that name a call without the agent's search text. */
const ACTIVITY_ARG_KEYS = ['path', 'glob', 'start', 'end', 'maxDepth'];

/**
 * Every conversation tool answer gets what the code review tools get: no
 * secret file's content, no line longer than MAX_TOOL_LINE_CHARS, no answer
 * longer than MAX_CONVERSATION_TOOL_OUTPUT_CHARS, the call marked in flight
 * for the stall watchdog, and a log when its post-processing is slow.
 */
function guardConversationTool(tool: ToolConfig): ToolConfig {
    const execute = tool.execute;
    return {
        ...tool,
        execute: async (input: unknown) => {
            const args = (input ?? {}) as Record<string, unknown>;
            const refused = refuseSecret(tool.name, args);
            if (refused) return refused;
            const summary =
                tool.name === 'exec'
                    ? `command=${
                          String(args.command ?? '')
                              .trim()
                              .split(/\s+/)[0] ?? ''
                      }`
                    : ACTIVITY_ARG_KEYS.filter(
                          (k) => args[k] !== undefined && args[k] !== '',
                      )
                          .map((k) => `${k}=${String(args[k]).slice(0, 120)}`)
                          .join(' ');
            const end = beginToolActivity(tool.name, summary);
            try {
                const out = await execute(input);
                return timeSync(
                    'conversation tool output (secret filter, line cut)',
                    () => guardOutput(tool.name, out),
                    () => ({ tool: tool.name }),
                );
            } finally {
                end();
            }
        },
    };
}

/** A path or command naming a secret file is refused, as code review does. */
function refuseSecret(
    name: string,
    args: Record<string, unknown>,
): { error: string } | undefined {
    if (name === 'exec') {
        // Best effort: a command whose words name a secret file (`cat .env`).
        const words = String(args.command ?? '').split(/[\s'"`;|&<>()]+/);
        const secret = words.find((w) => w && isSecretFilePath(w));
        return secret ? { error: secretFileRefusal(secret) } : undefined;
    }
    const path = String(args.path ?? '');
    return path && isSecretFilePath(path)
        ? { error: secretFileRefusal(path) }
        : undefined;
}

function guardOutput(name: string, out: unknown): unknown {
    if (!out || typeof out !== 'object') return out;
    const result = { ...(out as Record<string, unknown>) };
    for (const field of ['matches', 'content', 'listing', 'stdout', 'stderr']) {
        const value = result[field];
        if (typeof value !== 'string') continue;
        // Cut first: the guards below are synchronous and linear in what they
        // read, so they only ever read a bounded head of the answer.
        const { text: scanned, unread } = scanPrefix(value);
        let text =
            name === 'grep' || name === 'exec' || field === 'listing'
                ? withoutSecretFileLines(scanned)
                : scanned;
        const capped = cutLongLines(text);
        text = capped.text;
        if (text.length > MAX_CONVERSATION_TOOL_OUTPUT_CHARS || unread > 0) {
            const shown = text.slice(0, MAX_CONVERSATION_TOOL_OUTPUT_CHARS);
            const hidden = text.length - shown.length + unread;
            text = `${shown}\n... (${hidden} more characters not shown — narrow the call)`;
        }
        if (capped.cut > 0 || unread > 0 || text.length < value.length) {
            logger.warn({
                message: `[CONVERSATION-TOOLS] ${name} output cut before the agent`,
                context: 'ConversationTools',
                metadata: {
                    tool: name,
                    field,
                    outputChars: value.length,
                    longestLine: capped.longest,
                    linesCut: capped.cut,
                    files: capped.files,
                    maxLine: MAX_TOOL_LINE_CHARS,
                },
            });
        }
        result[field] = text;
    }
    return result;
}
