/**
 * Installs and fences the CLIs of the custom agents that will run (#2172).
 *
 * Runs once per review, right after the sandbox is acquired and before any
 * agent (and so before any secret) touches it. Only the isolated E2B sandbox
 * runs team CLIs: on the local sandbox the CLI would share the worker's host,
 * so nothing is installed and the tool is never offered. On E2B, only a
 * sandbox whose review user lost every root path at creation qualifies
 * (`privilegesDropped`), and that is checked again here; every step runs as
 * root through the sandbox's root channel.
 *
 * A CLI that cannot be installed, or whose network fence cannot be applied,
 * is dropped with a CLI_INSTALL_FAILED warning; the agent still runs without
 * it. Failing closed on the fence matters: a CLI with credentials and open
 * egress is exactly what the allowlist exists to prevent.
 */
import { createLogger } from '@libs/core/log/logger';
import {
    filesInAgentScope,
    ignoredFilesInAgentScope,
    selectCustomAgents,
} from '@libs/code-review/infrastructure/agents/custom-agents/custom-agent-scope';
import type {
    CliToolConfig,
    CustomAgentConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type {
    SandboxInstance,
    SandboxRunResult,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    buildCliInstallFailedWarning,
    type ReviewWarning,
} from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import {
    buildDropReviewUserPrivilegesScript,
    confirmsPrivilegesDropped,
    DROP_PRIVILEGES_TIMEOUT_MS,
} from '@libs/sandbox/infrastructure/providers/review-user-privileges';

import {
    buildInstallScript,
    buildNetworkScript,
    CLI_BINARY_MARKER,
    CLI_INSTALL_TIMEOUT_SEC,
    cliBinaryCandidates,
    cliSandboxIdentity,
    isReservedSecretEnv,
    isValidBinaryName,
    isValidDomain,
    planCliInstall,
    type CliSandboxIdentity,
} from './cli-command';

const logger = createLogger('CustomAgentCliProvisioner');

const NOT_LOCKED_DOWN =
    'the sandbox could not be locked down for credentials (its review user may still become root)';

export interface InstalledCustomAgentCli {
    agentId: string;
    agentName: string;
    cli: CliToolConfig;
    identity: CliSandboxIdentity;
    /** Absolute path the pinned install produced, inside the CLI user's home. */
    binaryPath: string;
}

export interface CustomAgentCliProvisioning {
    /** Installed and fenced CLIs, by custom agent id. */
    byAgentId: Record<string, InstalledCustomAgentCli[]>;
    warnings: ReviewWarning[];
}

/** Whether the agent will run for this change set: enabled, and at least one
 *  changed file is in its scope (no include globs means every file). */
export function customAgentMatchesFiles(
    agent: Pick<CustomAgentConfig, 'enabled' | 'scope'>,
    changedFiles: readonly string[],
): boolean {
    if (!agent?.enabled) return false;
    return touchesAgentScope(agent, changedFiles);
}

/** At least one changed file is in the agent's scope, or one ignored file
 *  its globs name explicitly (same rule as the orchestrator's dispatch). */
function touchesAgentScope(
    agent: Pick<CustomAgentConfig, 'scope'>,
    changedFiles: readonly string[],
    ignoredFiles: readonly string[] = [],
): boolean {
    const asFiles = (names: readonly string[]) =>
        names.map((filename) => ({ filename }));
    return (
        filesInAgentScope(agent, asFiles(changedFiles)).length > 0 ||
        ignoredFilesInAgentScope(agent, asFiles(ignoredFiles)).length > 0
    );
}

/** Run a script as root and read a non-zero exit as a result: E2B throws
 *  on it. */
async function runScript(
    sandbox: SandboxInstance,
    script: string,
    timeoutMs: number,
): Promise<SandboxRunResult> {
    try {
        return await sandbox.run(script, { timeoutMs, asRoot: true });
    } catch (error) {
        const e = error as Partial<SandboxRunResult> & { message?: string };
        if (typeof e?.exitCode === 'number') {
            return {
                stdout: e.stdout ?? '',
                stderr: e.stderr ?? '',
                exitCode: e.exitCode,
            };
        }
        return {
            stdout: '',
            stderr: e?.message ?? String(error),
            exitCode: -1,
        };
    }
}

/** Config problems that are known before touching the sandbox. */
function preflight(cli: CliToolConfig): string | null {
    if (!isValidBinaryName(cli.binary ?? '')) {
        return 'binary must be a plain executable name';
    }
    const badDomain = (cli.allowedDomains ?? []).find((d) => !isValidDomain(d));
    if (badDomain !== undefined) {
        return `allowed domain "${badDomain}" is not a plain host name`;
    }
    const reserved = (cli.secrets ?? []).find((s) =>
        isReservedSecretEnv(s.env),
    );
    if (reserved) {
        return `secret name ${reserved.env} is reserved`;
    }
    const plan = planCliInstall(cli);
    return plan.ok === false ? plan.reason : null;
}

export async function provisionCustomAgentClis(params: {
    sandbox: SandboxInstance | undefined;
    agents: readonly CustomAgentConfig[] | undefined;
    changedFiles: readonly string[];
    /** Changed files the ignore paths set aside, deleted ones excluded: an
     *  agent whose globs name one explicitly runs on it. */
    ignoredFiles?: readonly string[];
    /** `@kody -v <slug>`: only that agent runs, enabled or not. */
    onlyCustomAgent?: string;
    /** Set when this review must not run CLIs at all; each skipped CLI gets
     *  a warning with this reason. */
    skipReason?: string;
    /** The review's ids (organization, team, repository, PR) for the logs. */
    logContext?: Record<string, unknown>;
}): Promise<CustomAgentCliProvisioning> {
    const result: CustomAgentCliProvisioning = { byAgentId: {}, warnings: [] };
    const { sandbox } = params;

    // The agents the orchestrator will dispatch: the same selection, so a
    // CLI is installed exactly for an agent that runs.
    const candidates = selectCustomAgents(
        params.agents,
        params.onlyCustomAgent,
    ).filter(
        (agent) =>
            agent?.tools?.cli?.length &&
            touchesAgentScope(agent, params.changedFiles, params.ignoredFiles),
    );
    if (!candidates.length) return result;

    // Without the isolated sandbox, or on a review that must not run them,
    // the CLIs are not offered; say so instead of letting the agent run
    // without them silently.
    const skipReason =
        params.skipReason ??
        (!sandbox || sandbox.type !== 'e2b'
            ? 'needs the isolated (E2B) sandbox; this review ran without it'
            : sandbox.privilegesDropped !== true
              ? NOT_LOCKED_DOWN
              : undefined);
    if (skipReason) {
        for (const agent of candidates) {
            for (const cli of agent.tools.cli ?? []) {
                logger.log({
                    message: `Custom agent CLI not installed: ${cli.name}`,
                    context: 'provisionCustomAgentClis',
                    metadata: {
                        ...params.logContext,
                        agentId: agent.id,
                        cli: cli.name,
                        reason: skipReason,
                    },
                });
                result.warnings.push(
                    buildCliInstallFailedWarning({
                        agentName: agent.name,
                        cliName: cli.name,
                        reason: skipReason,
                    }),
                );
            }
        }
        return result;
    }

    // One log line per CLI the agent runs without: the reason, and for a
    // script that ran, its exit code and the tail of its stderr.
    const fail = (
        agent: CustomAgentConfig,
        cli: CliToolConfig,
        reason: string,
        run?: { exitCode?: number; stderr?: string },
    ) => {
        logger.warn({
            message: `Custom agent CLI unavailable: ${cli.name} (${reason})`,
            context: 'provisionCustomAgentClis',
            metadata: {
                ...params.logContext,
                agentId: agent.id,
                cli: cli.name,
                reason,
                ...(run && {
                    exitCode: run.exitCode,
                    stderr: (run.stderr ?? '').slice(-2_000),
                }),
            },
        });
        result.warnings.push(
            buildCliInstallFailedWarning({
                agentName: agent.name,
                cliName: cli.name,
                reason,
            }),
        );
    };

    const toInstall = candidates.flatMap((agent) =>
        (agent.tools.cli ?? []).flatMap((cli) => {
            const problem = preflight(cli);
            if (problem) {
                fail(agent, cli, problem);
                return [];
            }
            return [{ agent, cli }];
        }),
    );
    if (!toInstall.length) return result;

    // Re-checked on every review, before anything is installed: a resumed
    // sandbox must still be in the state its creation recorded.
    const lockdown = await runScript(
        sandbox,
        buildDropReviewUserPrivilegesScript(),
        DROP_PRIVILEGES_TIMEOUT_MS,
    );
    if (!confirmsPrivilegesDropped(lockdown)) {
        for (const { agent, cli } of toInstall) {
            fail(agent, cli, NOT_LOCKED_DOWN, lockdown);
        }
        return result;
    }

    // Installs run in parallel (each as its own user, before any fence);
    // the fences then go one by one, since they share /etc/hosts.
    const installs = await Promise.all(
        toInstall.map(async ({ agent, cli }) => {
            const plan = planCliInstall(cli);
            if (!plan.ok) return null;
            const identity = cliSandboxIdentity(agent.id, cli.name);
            const run = await runScript(
                sandbox,
                buildInstallScript({
                    identity,
                    argv: plan.argv,
                    binary: cli.binary,
                }),
                (CLI_INSTALL_TIMEOUT_SEC + 60) * 1000,
            );
            // The script prints the marker last; the install itself shares
            // stdout, so only a path inside the CLI user's own bin dirs is
            // believed, whatever a package's install output claims.
            const binaryPath = (run.stdout ?? '')
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.startsWith(CLI_BINARY_MARKER))
                .pop()
                ?.slice(CLI_BINARY_MARKER.length);
            const expected = cliBinaryCandidates(identity.home).map(
                (dir) => `${dir}/${cli.binary}`,
            );
            if (
                run.exitCode !== 0 ||
                !binaryPath ||
                !expected.includes(binaryPath)
            ) {
                fail(agent, cli, 'install failed', run);
                return null;
            }
            return { agent, cli, identity, binaryPath };
        }),
    );

    for (const installed of installs) {
        if (!installed) continue;
        const { agent, cli, identity, binaryPath } = installed;
        const fence = await runScript(
            sandbox,
            buildNetworkScript({
                identity,
                domains: cli.allowedDomains ?? [],
            }),
            60_000,
        );
        if (fence.exitCode !== 0) {
            fail(agent, cli, 'network allowlist could not be applied', fence);
            continue;
        }
        (result.byAgentId[agent.id] ??= []).push({
            agentId: agent.id,
            agentName: agent.name,
            cli,
            identity,
            binaryPath,
        });
    }

    return result;
}
