import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import {
    collectBranchDecisions,
    collectLocalDecisions,
} from '../../services/decision-recall.service.js';
import { listSessionRecords } from '../../services/local-session-store.service.js';
import { listCollisions } from '../../services/distillation.service.js';
import { detectHookInstallStatus } from './hooks.js';
import { cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';

export async function statusAction(): Promise<void> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliInfo(chalk.yellow('Not a git repository.'));
        cliInfo(
            'Trace status is available inside a repository. Session files still live under ~/.kodus/sessions/.',
        );
        exitWithCode(0);
        return;
    }

    const gitRoot = (await gitService.getGitRoot()).trim();

    const [sessions, localDecisions, branchDecisions, hooks, collisions] =
        await Promise.all([
            listSessionRecords(gitRoot),
            collectLocalDecisions(gitRoot),
            collectBranchDecisions(gitRoot),
            detectHookInstallStatus(gitRoot),
            listCollisions(5),
        ]);

    const lastCapture = sessions
        .map((s) => s.lastCaptureAt || s.startedAt)
        .filter(Boolean)
        .sort()
        .at(-1);

    if (
        sessions.length === 0 &&
        localDecisions.length === 0 &&
        branchDecisions.length === 0
    ) {
        cliInfo(chalk.cyan('Kodus Trace — nothing captured yet.'));
        cliInfo(
            'Run an agent session with hooks installed (`kodus trace enable`), then re-check here.',
        );
    } else {
        cliInfo(chalk.green('Kodus Trace status'));
        cliInfo(`  Sessions:          ${sessions.length}`);
        cliInfo(`  Decisions (local): ${localDecisions.length}`);
        cliInfo(`  Decisions (branch): ${branchDecisions.length}`);
        cliInfo(`  Last capture:      ${lastCapture ?? 'never'}`);
    }

    cliInfo('');
    cliInfo('Hook install:');
    cliInfo(
        `  Claude Code: ${hooks.claude ? chalk.green('installed') : chalk.dim('not installed')}`,
    );
    cliInfo(
        `  Cursor:      ${hooks.cursor ? chalk.green('installed') : chalk.dim('not installed')}`,
    );
    cliInfo(
        `  Codex:       ${hooks.codex ? chalk.green('installed') : chalk.dim('not installed')}`,
    );

    if (collisions.length > 0) {
        cliInfo('');
        cliInfo(chalk.yellow('Recent distillation collisions:'));
        for (const c of collisions) {
            cliInfo(`  - ${JSON.stringify(c)}`);
        }
    }
}
