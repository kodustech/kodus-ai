import { Command } from 'commander';
import chalk from 'chalk';
import open from 'open';
import { cliInfo } from '../utils/logger.js';

const UPGRADE_URL = 'https://kodus.io/pricing';

export async function openSubscriptionPage(
    openUrl: (url: string) => Promise<unknown> = (url) => open(url),
): Promise<boolean> {
    try {
        await openUrl(UPGRADE_URL);
        return true;
    } catch {
        return false;
    }
}

export const subscribeCommand = new Command('subscribe')
    .description('Open the subscription page in your browser')
    .action(async () => {
        cliInfo(chalk.blue('\nOpening subscription page...'));
        cliInfo(chalk.dim(`URL: ${UPGRADE_URL}\n`));

        const opened = await openSubscriptionPage();
        if (!opened) {
            cliInfo(chalk.yellow(`Please visit: ${UPGRADE_URL}`));
        }
    });
