/**
 * `runCli`: the custom agent's door to its team's CLIs (#2172).
 *
 * Offered only when the review runs on the isolated E2B sandbox and at least
 * one of the agent's CLIs was installed and fenced. Each call is checked
 * against the CLI's allowed prefixes, runs as argv (no shell) under its own
 * user and timeout, receives its secrets only through its process env (and
 * none at all when it runs project code), and answers with output that has
 * every secret spelling masked and is capped in size.
 */
import { jsonSchema } from 'ai';

import type { AgentTool } from '@libs/agent-harness/domain/contracts/tool.contract';

import type { CustomAgentCliRun } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import {
    cliEnvExposureProblem,
    cliSecretReferenceProblem,
} from '@libs/core/infrastructure/config/types/general/cli-env-guard';
import { createLogger } from '@libs/core/log/logger';
import type {
    SandboxInstance,
    SandboxRunResult,
} from '@libs/sandbox/domain/contracts/sandbox.provider';

import {
    buildRunCommand,
    matchesAllowedPrefix,
    normalizeCliArgs,
    prefixTokens,
    resolveCliTimeoutSec,
    validateCliArgs,
} from './cli-command';
import { capCliOutput, maskSecrets } from './cli-output-mask';
import type { InstalledCustomAgentCli } from './custom-agent-cli.provisioner';

const logger = createLogger('RunCliTool');

export const RUN_CLI_TOOL_NAME = 'runCli';

export interface RunCliToolDeps {
    sandbox: SandboxInstance | undefined;
    installed: readonly InstalledCustomAgentCli[] | undefined;
    /** Decrypts a stored secret ciphertext (`decrypt` from common/utils/crypto). */
    decrypt: (ciphertext: string) => string;
    /** Told of each call and the output the agent got. */
    onRun?: (run: Omit<CustomAgentCliRun, 'agentId'>) => void;
    /** The review's ids (organization, team, repository, PR) for the logs. */
    logContext?: Record<string, unknown>;
}

function describe(installed: readonly InstalledCustomAgentCli[]): string {
    const sections = installed.map(({ cli }) => {
        const prefixes = cli.allowedPrefixes.map((p) => `\`${p}\``).join(', ');
        return [
            `### ${cli.name}`,
            `Allowed argument prefixes: ${prefixes}.`,
            cli.usage?.trim() || '(no usage notes)',
        ].join('\n');
    });
    return [
        'Run one of the team CLIs configured for this review, inside the repository checkout.',
        "Pass `cli` (its name) and `args` (argv tokens, without the binary). There is no shell: pipes, redirects, globs and variables are passed literally. args must start with one of the CLI's allowed prefixes. Credentials, when the CLI has any, are already provided; never ask for them or print them.",
        '',
        ...sections,
    ].join('\n');
}

function normalizeRun(error: unknown): SandboxRunResult | null {
    const e = error as Partial<SandboxRunResult>;
    if (typeof e?.exitCode !== 'number') return null;
    return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        exitCode: e.exitCode,
    };
}

function formatRun(run: SandboxRunResult, timeoutSec: number): string {
    const parts = [run.stdout?.trimEnd() ?? ''];
    if (run.stderr?.trim()) parts.push(`[stderr]\n${run.stderr.trimEnd()}`);
    if (run.exitCode === 124) {
        parts.push(`[timed out after ${timeoutSec}s]`);
    }
    parts.push(`[exit code ${run.exitCode}]`);
    return parts.filter(Boolean).join('\n');
}

export async function executeRunCli(
    deps: RunCliToolDeps & { installed: readonly InstalledCustomAgentCli[] },
    input: { cli?: unknown; args?: unknown },
): Promise<string> {
    const { sandbox, installed, decrypt } = deps;
    if (!sandbox || sandbox.type !== 'e2b') {
        return 'Error: team CLIs are not available in this review.';
    }

    const entry = installed.find((item) => item.cli.name === input?.cli);
    if (!entry) {
        return `Error: unknown CLI "${String(input?.cli)}". Available: ${installed
            .map((item) => item.cli.name)
            .join(', ')}.`;
    }
    const { cli } = entry;

    const argsError = validateCliArgs(input?.args);
    if (argsError) return `Error: ${argsError}.`;
    // Models often repeat the binary as argv[0]; it is never an argument.
    const given = input.args as string[];
    const args = normalizeCliArgs(
        given[0] === cli.binary || given[0] === cli.name
            ? given.slice(1)
            : given,
        cli,
    );

    if (!matchesAllowedPrefix(args, cli)) {
        // As argv arrays: shown as one string, models sent it as one argument.
        return `Error: these arguments are not allowed for ${cli.name}. args must start with one of these argument lists: ${cli.allowedPrefixes
            .map((p) => JSON.stringify(prefixTokens(p, cli)))
            .join(
                ', ',
            )} — each element is one argument; a "dir/" element accepts any path under it.`;
    }

    // A CLI with credentials never runs a call that would print them: env
    // listings, /proc, known token-printing subcommands, or an argument the
    // CLI could expand into a secret. (argv itself never reaches a shell.)
    if (!cli.runsProjectCode && cli.secrets?.length) {
        const exposure =
            cliEnvExposureProblem(args) ??
            cliSecretReferenceProblem(
                args,
                cli.secrets.map((secret) => secret.env),
            );
        if (exposure) {
            return `Error: refused, ${exposure}; this CLI holds credentials. The CLI was not run.`;
        }
    }

    // Decrypted here, for this one process, and never kept. A CLI that runs
    // project code gets no secret at all: the code it runs is the PR's.
    const envs: Record<string, string> = {};
    if (!cli.runsProjectCode) {
        for (const secret of cli.secrets ?? []) {
            let value = '';
            try {
                value = decrypt(secret.ciphertext);
            } catch {
                value = '';
            }
            if (!value) {
                logger.warn({
                    message: `runCli: secret ${secret.env} of ${cli.name} could not be decrypted; not run`,
                    context: 'runCli',
                    metadata: {
                        ...deps.logContext,
                        agentId: entry.agentId,
                        cli: cli.name,
                        secretEnv: secret.env,
                    },
                });
                return `Error: credential ${secret.env} for ${cli.name} is not available; the CLI was not run.`;
            }
            envs[secret.env] = value;
        }
    }
    const secretValues = Object.values(envs);
    const timeoutSec = resolveCliTimeoutSec(cli);

    const command = buildRunCommand({
        identity: entry.identity,
        binaryPath: entry.binaryPath,
        args,
        secretEnvNames: Object.keys(envs),
        timeoutSec,
    });

    let run: SandboxRunResult;
    try {
        // As root: the review user has no sudo, and the process holding the
        // secrets must not be one the review user owns.
        run = await sandbox.run(command, {
            timeoutMs: (timeoutSec + 15) * 1000,
            asRoot: true,
            ...(secretValues.length ? { envs } : {}),
        });
    } catch (error) {
        const normalized = normalizeRun(error);
        if (!normalized) {
            const message = maskSecrets(
                error instanceof Error ? error.message : String(error),
                secretValues,
            );
            logger.warn({
                message: `runCli failed to execute ${cli.name}`,
                context: 'runCli',
                metadata: {
                    ...deps.logContext,
                    agentId: entry.agentId,
                    cli: cli.name,
                    message,
                },
            });
            return capCliOutput(`Error: ${message}`);
        }
        run = normalized;
    }

    return capCliOutput(maskSecrets(formatRun(run, timeoutSec), secretValues));
}

/**
 * The `runCli` tool in the AI SDK shape the review agents use, or `{}` when
 * the agent has no usable CLI (no E2B sandbox, nothing installed).
 */
export function buildRunCliTool(deps: RunCliToolDeps): Record<string, any> {
    const { sandbox, installed } = deps;
    if (!sandbox || sandbox.type !== 'e2b' || !installed?.length) return {};
    const names = installed.map((item) => item.cli.name);
    return {
        [RUN_CLI_TOOL_NAME]: {
            type: 'function' as const,
            description: describe(installed),
            inputSchema: jsonSchema({
                type: 'object',
                properties: {
                    cli: {
                        type: 'string',
                        enum: names,
                        description: 'Name of the CLI to run.',
                    },
                    args: {
                        type: 'array',
                        items: { type: 'string' },
                        description:
                            'argv tokens after the binary, starting with an allowed prefix.',
                    },
                },
                required: ['cli', 'args'],
                additionalProperties: false,
            }),
            execute: (input: { cli?: unknown; args?: unknown }) =>
                executeRunCli({ ...deps, installed }, input),
        },
    };
}

/**
 * `runCli` as a harness tool (what a custom agent's run registers), or
 * undefined when the agent has no usable CLI.
 */
export function buildRunCliAgentTool(
    deps: RunCliToolDeps,
): AgentTool<{ cli?: unknown; args?: unknown }> | undefined {
    const { sandbox, installed } = deps;
    if (!sandbox || sandbox.type !== 'e2b' || !installed?.length) {
        return undefined;
    }
    const names = installed.map((item) => item.cli.name);
    return {
        name: RUN_CLI_TOOL_NAME,
        description: describe(installed),
        inputSchema: {
            type: 'object',
            properties: {
                cli: {
                    type: 'string',
                    enum: names,
                    description: 'Name of the CLI to run.',
                },
                args: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'argv tokens after the binary, starting with an allowed prefix.',
                },
            },
            required: ['cli', 'args'],
            additionalProperties: false,
        },
        async execute(input) {
            const output = await executeRunCli({ ...deps, installed }, input);
            deps.onRun?.({
                cli: String(input?.cli ?? ''),
                args: Array.isArray(input?.args) ? input.args.map(String) : [],
                output,
            });
            return { output, isError: output.startsWith('Error:') };
        },
    };
}
