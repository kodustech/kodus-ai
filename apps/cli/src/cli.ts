import { Command } from 'commander';
import { createRequire } from 'node:module';
import { authCommand } from './commands/auth/index.js';
import { configCommand } from './commands/config.js';
import { diffCommand } from './commands/diff.js';
import { hookCommand } from './commands/hook/index.js';
import { decisionsCommand } from './commands/memory/index.js';
import { prCommand } from './commands/pr.js';
import { reviewCommand } from './commands/review.js';
import { rulesCommand } from './commands/rules.js';
import { createSchemaCommand } from './commands/schema.js';
import { skillsCommand } from './commands/skills.js';
import { statusCommand } from './commands/status.js';
import { subscribeCommand } from './commands/subscribe.js';
import { updateCommand } from './commands/update.js';
import { applyCommanderBehavior } from './utils/commander-setup.js';
import { setCliOutputMode } from './utils/logger.js';
import { recordRecentActivity } from './utils/recent-activity.js';
import { checkForUpdates } from './utils/update-check.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();

program
    .name('kodus')
    .description('Kodus CLI - AI-powered code review from your terminal')
    .version(pkg.version)
    .option(
        '-f, --format <format>',
        'Output format: terminal, json, markdown',
        'terminal',
    )
    .option('-o, --output <file>', 'Output file (for json/markdown)')
    .option('-v, --verbose', 'Verbose output', false)
    .option('-q, --quiet', 'Quiet mode (errors only)', false)
    .option('--agent', 'Agent mode: deterministic machine-readable output');

program.addCommand(reviewCommand);
program.addCommand(diffCommand);
program.addCommand(authCommand);
program.addCommand(subscribeCommand);
program.addCommand(updateCommand);
program.addCommand(prCommand);
program.addCommand(hookCommand);
program.addCommand(decisionsCommand);
program.addCommand(statusCommand);
program.addCommand(skillsCommand);
program.addCommand(rulesCommand);
program.addCommand(configCommand);
program.addCommand(createSchemaCommand(() => program));
applyCommanderBehavior(program);

program.hook('preAction', (_thisCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals() as {
        quiet?: boolean;
        verbose?: boolean;
    };
    setCliOutputMode({
        quiet: !!opts.quiet,
        verbose: !!opts.verbose,
    });
});

program.hook('postAction', async () => {
    await Promise.all([
        checkForUpdates(),
        recordRecentActivity(process.argv.slice(2)).catch(() => {}),
    ]);
});

export { program };
