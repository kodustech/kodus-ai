import { z } from 'zod';

import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

/**
 * Shape of a `@kodus/flow` tool config — locally typed to avoid importing from
 * a non-public path of the package. Matches `ToolConfig` from the SDK at the
 * fields actually consumed by `orchestration.createTool(...)`.
 */
type ToolConfig = {
    name: string;
    description: string;
    inputSchema: z.ZodSchema<unknown>;
    execute: (input: unknown) => Promise<unknown>;
};

/**
 * Native tools backed by the sandbox `RemoteCommands` contract. These are
 * registered into a `@kodus/flow` orchestration via `orchestration.createTool`.
 *
 * Sandbox is captured by closure — `ToolContext` does not propagate `userContext`
 * down to tools, so each `@kody` request creates its own ephemeral orchestration
 * with tools wired to that request's sandbox instance.
 *
 * NullSandbox path: when `sandbox.type === 'null'`, this returns `[]`. The
 * agent then falls back to MCP-only tools (memory) — same shape as before
 * the runtime sandbox integration.
 */
export function buildNativeToolConfigs(
    sandbox: SandboxInstance,
): ToolConfig[] {
    if (sandbox.type === 'null') {
        return [];
    }

    const remote = sandbox.remoteCommands;

    const grepTool: ToolConfig = {
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
        execute: async (input: unknown) => {
            const { pattern, path, glob } = input as {
                pattern: string;
                path?: string;
                glob?: string;
            };
            const result = await remote.grep(pattern, path ?? '.', glob);
            return { matches: result };
        },
    };

    const readFileTool: ToolConfig = {
        name: 'readFile',
        description:
            'Read a file from the repository between two line numbers (1-indexed, inclusive). Use to inspect implementation details after grep.',
        inputSchema: z.object({
            path: z
                .string()
                .describe('Repo-relative path to the file.'),
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
        execute: async (input: unknown) => {
            const { path, start, end } = input as {
                path: string;
                start: number;
                end: number;
            };
            const content = await remote.read(path, start, end);
            return { content };
        },
    };

    const listDirTool: ToolConfig = {
        name: 'listDir',
        description:
            'List files and folders under a directory in the repository, up to a maximum depth. Use to explore unfamiliar projects.',
        inputSchema: z.object({
            path: z
                .string()
                .describe('Repo-relative directory path.'),
            maxDepth: z
                .number()
                .int()
                .min(1)
                .max(10)
                .default(2)
                .describe('Maximum recursion depth. Default 2.'),
        }),
        execute: async (input: unknown) => {
            const { path, maxDepth } = input as {
                path: string;
                maxDepth?: number;
            };
            const listing = await remote.listDir(path, maxDepth ?? 2);
            return { listing };
        },
    };

    const tools: ToolConfig[] = [grepTool, readFileTool, listDirTool];

    // exec is optional on RemoteCommands — only expose when the provider implements it
    if (typeof remote.exec === 'function') {
        const execFn = remote.exec;
        tools.push({
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
            execute: async (input: unknown) => {
                const { command } = input as { command: string };
                const result = await execFn(command);
                return result;
            },
        });
    }

    return tools;
}
