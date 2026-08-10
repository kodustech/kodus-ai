import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import {
    forgetDecision,
    pinDecision,
    unpinDecision,
} from '../../services/trace/overrides.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { updateSharedDecisionCorrection } from '../../services/trace/shared-corrections.js';

async function requireGitRoot(): Promise<string | null> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliError(chalk.red('Error: Not a git repository.'));
        exitWithCode(1);
        return null;
    }
    return (await gitService.getGitRoot()).trim();
}

/** Drop a decision the model got wrong. Recall stops returning it. */
export async function forgetAction(decisionId: string): Promise<void> {
    const gitRoot = await requireGitRoot();
    if (!gitRoot) {
        return;
    }

    const overrides = await forgetDecision(gitRoot, decisionId);
    const shared = await updateSharedDecisionCorrection(
        gitRoot,
        decisionId,
        'forget',
    ).catch(() => ({ found: false, pushed: false }));
    cliInfo(chalk.green(`✓ Forgot decision ${decisionId}.`));
    cliInfo(chalk.dim(`  ${overrides.forgotten.length} forgotten in total.`));
    reportSharedOutcome(shared);
}

/** Mark a decision that should always make the context pack. */
export async function pinAction(
    decisionId: string,
    options: { remove?: boolean } = {},
): Promise<void> {
    const gitRoot = await requireGitRoot();
    if (!gitRoot) {
        return;
    }

    if (options.remove) {
        const overrides = await unpinDecision(gitRoot, decisionId);
        const shared = await updateSharedDecisionCorrection(
            gitRoot,
            decisionId,
            'unpin',
        ).catch(() => ({ found: false, pushed: false }));
        cliInfo(chalk.green(`✓ Unpinned decision ${decisionId}.`));
        cliInfo(chalk.dim(`  ${overrides.pinned.length} pinned in total.`));
        reportSharedOutcome(shared);
        return;
    }

    const overrides = await pinDecision(gitRoot, decisionId);
    const shared = await updateSharedDecisionCorrection(
        gitRoot,
        decisionId,
        'pin',
    ).catch(() => ({ found: false, pushed: false }));
    cliInfo(chalk.green(`✓ Pinned decision ${decisionId}.`));
    cliInfo(chalk.dim(`  ${overrides.pinned.length} pinned in total.`));
    reportSharedOutcome(shared);
}

function reportSharedOutcome(outcome: {
    found: boolean;
    pushed: boolean;
    pushError?: string;
}): void {
    if (!outcome.found) {
        cliInfo(
            chalk.dim(
                '  Saved locally; the shared decision was not available in this clone.',
            ),
        );
    } else if (outcome.pushed) {
        cliInfo(chalk.dim('  Published to kodus/trace/v1.'));
    } else {
        cliInfo(
            chalk.dim(
                '  Saved to the local Trace ref; it will publish on the next available push.',
            ),
        );
    }
}
