import { Command } from 'commander';
import { installAction } from './install.js';
import { uninstallAction } from './uninstall.js';
import { statusAction } from './status.js';

export const hookCommand = new Command('hook').description(
    'Manage pre-push hook for automatic code review',
);

hookCommand
    .command('install')
    .description('Install pre-push hook for automatic code review')
    .option(
        '--fail-on <severity>',
        'Minimum severity to block push (info, warning, error, critical)',
        'critical',
    )
    .option('--fast', 'Use fast mode for review (default: true)', true)
    .option('--no-fast', 'Disable fast mode for review')
    .option('--force', 'Overwrite existing hook without prompting')
    .option('--dry-run', 'Print planned changes without writing files', false)
    .action((options, cmd) => installAction(options, cmd.optsWithGlobals()));

hookCommand
    .command('uninstall')
    .description('Remove pre-push hook installed by kodus')
    .option('--dry-run', 'Print planned changes without writing files', false)
    .action((options, cmd) => uninstallAction(options, cmd.optsWithGlobals()));

hookCommand
    .command('status')
    .description('Show pre-push hook status')
    .action(statusAction);
