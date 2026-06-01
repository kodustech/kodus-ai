#!/usr/bin/env node

import { program } from './cli.js';
import { showBanner } from './utils/banner.js';
import { checkForUpdates } from './utils/update-check.js';
import { isCliExitError, isCommanderExitError } from './utils/cli-exit.js';
import { cliError } from './utils/logger.js';
import { formatCommanderError } from './utils/commander-errors.js';

function normalizeDecisionsCaptureLegacyArgs(args: string[]): string[] {
    const decisionsIndex = args.indexOf('decisions');
    if (decisionsIndex === -1 || args[decisionsIndex + 1] !== 'capture') {
        return args;
    }

    const normalized = [...args];
    for (let i = decisionsIndex + 2; i < normalized.length; i += 1) {
        if (normalized[i] === '--agent') {
            const next = normalized[i + 1];
            if (next && !next.startsWith('-')) {
                normalized[i] = '--capture-agent';
            }
        }
    }

    return normalized;
}

async function main(): Promise<void> {
    if (!process.argv.slice(2).length) {
        await showBanner();
        await checkForUpdates();
        return;
    }

    const args = normalizeDecisionsCaptureLegacyArgs(process.argv.slice(2));
    await program.parseAsync([process.argv[0], process.argv[1], ...args]);
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
