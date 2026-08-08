import { Command } from 'commander';
import { enableAction } from './enable.js';
import { disableAction } from './disable.js';
import { sessionHooksCommand } from './session-hooks/index.js';
import { statusAction } from './status.js';
import { recallAction } from './recall.js';
import { forgetAction } from './forget.js';
import { pinAction } from './pin.js';
import { uiAction } from './ui.js';
import { distillAction } from './distill.js';
import type { GlobalOptions } from '../../types/cli.js';

/**
 * Registered subcommand names. When the first positional arg matches one of
 * these, Commander routes to the subcommand; otherwise it is treated as a
 * path for recall. Ambiguity is resolved in favor of the registered name;
 * use `--` to force path interpretation.
 */
export const TRACE_SUBCOMMANDS = [
    'enable',
    'disable',
    'status',
    'forget',
    'pin',
    'ui',
    'hooks',
    '_distill-internal',
] as const;

export const traceCommand = new Command('trace').description(
    'Capture, recall, and share why code was written (local-first decision memory)',
);

traceCommand.addCommand(sessionHooksCommand);

traceCommand
    .command('enable')
    .description('Install session tracking hooks and push refspec')
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
    .description('Remove all trace hooks')
    .option('--dry-run', 'Show what would be removed without changing files')
    .action((options, command) =>
        disableAction(options, command.optsWithGlobals() as GlobalOptions),
    );

traceCommand
    .command('status')
    .description(
        'Report sessions, decisions, last capture, and hook install state',
    )
    .action(statusAction);

traceCommand
    .command('forget')
    .description('Remove a decision from future recall and context packs')
    .argument('<id>', 'Decision id')
    .action(forgetAction);

traceCommand
    .command('pin')
    .description('Pin a decision so context-pack budgeting never drops it')
    .argument('<id>', 'Decision id')
    .action(pinAction);

traceCommand
    .command('ui')
    .description('Serve a local SPA reading the local session store (no auth)')
    .option('--port <port>', 'Port to bind (default 7432)')
    .action(uiAction);

// Internal: invoked by pre-push / detached spawn. Not documented in README.
traceCommand
    .command('_distill-internal', { hidden: true })
    .description('Internal: run branch distillation (fail-open)')
    .option('--push', 'Push orphan branch after distill')
    .action(distillAction);

/**
 * Path-positional recall on the group itself:
 *   kodus trace src/billing/invoice.ts
 * Registered subcommands always win over path ambiguity.
 */
traceCommand
    .argument('[paths...]', 'Paths to recall decisions for')
    .action(async (paths: string[]) => {
        // Commander only reaches this action when no subcommand matched.
        await recallAction(paths ?? []);
    });
