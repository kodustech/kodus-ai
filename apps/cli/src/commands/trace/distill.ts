import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import {
    resolveAgentCli,
    runAgentCli,
} from '../../services/trace/agent-cli.js';
import { distillBranch } from '../../services/trace/distill.service.js';
import { recordIncident } from '../../services/trace/incidents.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import type { GlobalOptions } from '../../types/cli.js';

export interface DistillActionOptions {
    branch?: string;
    agentCli?: string;
    remote?: string;
    push?: boolean;
}

/**
 * Internal: run by the detached pre-push hook. Safe to run by hand.
 *
 * Every exit path here is zero. A push must not fail because a model was
 * unavailable, and a developer with no agent CLI installed still gets capture.
 */
export async function distillAction(
    options: DistillActionOptions = {},
    globalOpts?: GlobalOptions,
): Promise<void> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliError(chalk.red('Error: Not a git repository.'));
        exitWithCode(1);
        return;
    }

    const gitRoot = (await gitService.getGitRoot()).trim();
    const branch =
        options.branch?.trim() ||
        (await gitService.getCurrentBranch().catch(() => '')).trim();

    if (!branch) {
        cliInfo(
            chalk.dim(
                'Detached HEAD — nothing to distill (records are keyed by branch).',
            ),
        );
        return;
    }

    const agent = await resolveAgentCli(options.agentCli);
    if (!agent) {
        cliInfo(
            chalk.yellow(
                'No agent CLI found on PATH (looked for claude, codex, gemini, cursor-agent).',
            ),
        );
        cliInfo(
            chalk.dim(
                'Skipping distillation. Capture still works — install one of those CLIs to get decisions.',
            ),
        );
        return;
    }

    try {
        const result = await distillBranch(gitRoot, {
            branch,
            remote: options.remote,
            push: options.push !== false,
            runAgent: (prompt) =>
                runAgentCli(agent.spec, prompt, { cwd: gitRoot }),
        });

        if (globalOpts?.format === 'json' || globalOpts?.agent) {
            cliInfo(
                JSON.stringify(
                    {
                        branch,
                        agentCli: agent.spec.name,
                        decisions: result.record.decisions.length,
                        commitsProcessed: result.commitsProcessed,
                        commitsReused: result.commitsReused,
                        pushed: result.pushed,
                        pushRetried: result.pushRetried,
                        pushError: result.pushError,
                    },
                    null,
                    2,
                ),
            );
            return;
        }

        cliInfo(
            chalk.green(
                `✓ Distilled ${branch}: ${result.record.decisions.length} decisions ` +
                    `(${result.commitsProcessed} commits summarized, ${result.commitsReused} reused).`,
            ),
        );

        if (result.pushError) {
            cliInfo(
                chalk.yellow(
                    `  Could not push kodus/trace/v1: ${result.pushError}`,
                ),
            );
            cliInfo(chalk.dim('  Reported by `kodus trace status`.'));
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordIncident(gitRoot, {
            at: new Date().toISOString(),
            kind: 'distill-failure',
            branch,
            message,
        });
        cliInfo(chalk.yellow(`Distillation skipped: ${message}`));
    }
}
