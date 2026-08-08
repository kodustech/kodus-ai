import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import {
    findAgentCli,
    pushOrphanBranch,
    runDistillation,
} from '../../services/distillation.service.js';
import { cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';

/**
 * Internal/pre-push entry: always exit 0 (fail-open).
 */
export async function distillAction(options: {
    push?: boolean;
}): Promise<void> {
    try {
        const isRepo = await gitService.isGitRepository();
        if (!isRepo) {
            exitWithCode(0);
            return;
        }

        const gitRoot = (await gitService.getGitRoot()).trim();
        const agentCli = await findAgentCli();
        if (!agentCli) {
            // Still attempt local aggregation; runDistillation handles empty.
            cliInfo(
                chalk.dim(
                    '[trace] No agent CLI on PATH (claude/codex/gemini/cursor); distilling from local decisions only.',
                ),
            );
        }

        const result = await runDistillation(gitRoot);
        if (result.skipped) {
            if (result.reason) {
                cliInfo(chalk.dim(`[trace] distill skipped: ${result.reason}`));
            }
            exitWithCode(0);
            return;
        }

        cliInfo(
            chalk.green(
                `[trace] distilled branch record ${result.recordId} → ${result.shardPath}`,
            ),
        );

        if (options.push) {
            const pushResult = await pushOrphanBranch(gitRoot);
            if (pushResult.collision) {
                cliInfo(
                    chalk.yellow(
                        `[trace] orphan branch push collision (see kodus trace status): ${pushResult.message ?? ''}`,
                    ),
                );
            }
        }
    } catch (error) {
        if (process.env.KODUS_VERBOSE === 'true') {
            const message =
                error instanceof Error ? error.message : String(error);
            cliInfo(chalk.dim(`[trace] distill error (fail-open): ${message}`));
        }
    }
    exitWithCode(0);
}
