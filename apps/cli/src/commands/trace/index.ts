import { Command } from 'commander';
import { enableAction } from './enable.js';
import { disableAction } from './disable.js';
import { statusAction } from './status.js';
import { recallAction } from './recall.js';
import { forgetAction, pinAction } from './corrections.js';
import { distillAction } from './distill.js';
import { commitTrailerAction } from './commit-trailer.js';
import { uiAction } from './ui.js';
import { sessionHooksCommand } from './session-hooks/index.js';
import type { GlobalOptions } from '../../types/cli.js';

/**
 * The group takes either a subcommand or a path list. Reading is the common
 * case, so it needs no verb: `kodus trace src/billing/invoice.ts`.
 *
 * A registered subcommand name always wins over a path — Commander resolves it
 * before the group's own arguments — and a path that collides with one is
 * disambiguated with `--`, which `normalizeTraceArgv` rewrites into `--path`.
 */
export const traceCommand = new Command('trace')
    .description(
        'Read the decisions recorded for a path, and manage session capture',
    )
    .argument('[paths...]', 'Paths to recall decisions for')
    .option('--path <path>', 'Path to recall (repeatable)', collectPath, [])
    .option('--limit <n>', 'Maximum number of decisions to print')
    .option('--remote <name>', 'Git remote holding the decision branch')
    .action((paths: string[], options, command) =>
        recallAction(
            paths,
            options,
            command.optsWithGlobals() as GlobalOptions,
        ),
    );

function collectPath(value: string, previous: string[]): string[] {
    return [...previous, value];
}

traceCommand.addCommand(sessionHooksCommand);

traceCommand
    .command('enable')
    .description('Install session capture hooks for this repository')
    .option(
        '--agents <agents>',
        'Comma-separated list: claude,cursor,codex',
        'claude,cursor,codex',
    )
    .option(
        '--codex-config <path>',
        'Path to Codex config.toml (default: ~/.codex/config.toml)',
    )
    .action(enableAction);

traceCommand
    .command('disable')
    .description('Remove all session capture hooks')
    .option('--dry-run', 'Show what would be removed without writing', false)
    .action((options, command) =>
        disableAction(options, command.optsWithGlobals() as GlobalOptions),
    );

traceCommand
    .command('status')
    .description('Report what has been captured and which hooks are installed')
    .action((options, command) =>
        statusAction(options, command.optsWithGlobals() as GlobalOptions),
    );

traceCommand
    .command('forget')
    .description('Remove a decision the model got wrong')
    .argument('<id>', 'Decision id, as printed by `kodus trace <path>`')
    .action(forgetAction);

traceCommand
    .command('pin')
    .description('Mark a decision that should always make the context pack')
    .argument('<id>', 'Decision id, as printed by `kodus trace <path>`')
    .option('--remove', 'Unpin instead of pinning', false)
    .action(pinAction);

traceCommand
    .command('ui')
    .description('Serve the local session browser')
    .option('--port <port>', 'Port to listen on', '4711')
    .option('--no-open', 'Do not open a browser')
    .action(uiAction);

traceCommand
    .command('distill', { hidden: true })
    .description('Internal: distill a branch into decisions (run by pre-push)')
    .option('--branch <branch>', 'Branch to distill (default: current)')
    .option(
        '--agent-cli <name>',
        'Force an agent CLI: claude, codex, gemini, cursor',
    )
    .option('--remote <name>', 'Git remote to push the decision branch to')
    .option('--no-push', 'Write the record locally without pushing')
    .action((options, command) =>
        distillAction(options, command.optsWithGlobals() as GlobalOptions),
    );

traceCommand
    .command('commit-trailer', { hidden: true })
    .description(
        'Internal: print the Kodus-Trace trailer for the current commit',
    )
    .action(commitTrailerAction);
