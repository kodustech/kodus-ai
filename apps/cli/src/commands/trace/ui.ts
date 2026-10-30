import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import { startTraceUiServer } from '../../services/trace/ui-server.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';

export interface UiActionOptions {
    port?: string;
    open?: boolean;
}

export async function uiAction(options: UiActionOptions = {}): Promise<void> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliError(chalk.red('Error: Not a git repository.'));
        exitWithCode(1);
        return;
    }

    const gitRoot = (await gitService.getGitRoot()).trim();
    const port = options.port ? Number.parseInt(options.port, 10) : 4711;

    const server = await startTraceUiServer(gitRoot, {
        port: Number.isFinite(port) ? port : 4711,
    });

    cliInfo(chalk.green(`✓ Kodus Trace UI running at ${server.url}`));
    cliInfo(chalk.dim('  Reads the local store only. Ctrl-C to stop.'));

    if (options.open !== false) {
        try {
            const { default: open } = await import('open');
            await open(server.url);
        } catch {
            // A headless machine just gets the URL printed.
        }
    }

    await new Promise<void>((resolve) => {
        const stop = (): void => {
            void server.close().then(resolve);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
    });
}
