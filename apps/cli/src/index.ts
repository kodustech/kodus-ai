#!/usr/bin/env node

import { program } from './cli.js';
import { showBanner } from './utils/banner.js';
import { checkForUpdates } from './utils/update-check.js';
import { isCliExitError, isCommanderExitError } from './utils/cli-exit.js';
import { cliError } from './utils/logger.js';
import { formatCommanderError } from './utils/commander-errors.js';

async function main(): Promise<void> {
    if (!process.argv.slice(2).length) {
        await showBanner();
        await checkForUpdates();
        return;
    }

    await program.parseAsync(process.argv);
}

try {
    await main();
} catch (error) {
    if (isCliExitError(error)) {
        process.exitCode = error.exitCode;
    } else if (isCommanderExitError(error)) {
        cliError(formatCommanderError(error, process.argv.slice(2)));
        process.exitCode = error.exitCode;
    } else {
        if (error instanceof Error && error.message) {
            cliError(error.message);
        }
        process.exitCode = 1;
    }
}
