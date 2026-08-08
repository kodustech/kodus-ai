import { gitService } from '../../services/git.service.js';
import {
    formatDecisions,
    recallDecisions,
} from '../../services/decision-recall.service.js';
import { cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';

/**
 * Path-positional recall: `kodus trace <paths...>`
 * Reads local sessions + orphan branch offline. Empty result → exit 0.
 */
export async function recallAction(paths: string[]): Promise<void> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        // Not in a repo: still exit 0 with empty result
        exitWithCode(0);
        return;
    }

    const gitRoot = (await gitService.getGitRoot()).trim();
    const decisions = await recallDecisions(gitRoot, paths);
    const formatted = formatDecisions(decisions);
    if (formatted) {
        cliInfo(formatted);
    }
    exitWithCode(0);
}
