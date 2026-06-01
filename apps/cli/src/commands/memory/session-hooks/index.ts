import { Command } from 'commander';
import { claudeCodeHookAction } from './claude-code.js';
import { cursorHookAction } from './cursor.js';
import { codexHookAction } from './codex.js';

export const sessionHooksCommand = new Command('hooks').description(
    'Internal session lifecycle hook handlers',
);

sessionHooksCommand
    .command('claude-code')
    .description('Handle Claude Code lifecycle hooks')
    .argument(
        '<hook-name>',
        'Hook event name (session-start, session-end, stop, user-prompt-submit, pre-task, post-task, post-todo)',
    )
    .action(claudeCodeHookAction);

sessionHooksCommand
    .command('cursor')
    .description('Handle Cursor lifecycle hooks')
    .argument(
        '<hook-name>',
        'Hook event name (sessionStart, sessionEnd, stop, beforeSubmitPrompt, subagentStart, subagentStop)',
    )
    .action(cursorHookAction);

sessionHooksCommand
    .command('codex')
    .description('Handle Codex CLI lifecycle hooks')
    .argument(
        '<hook-name>',
        'Hook event name (AfterAgent, AfterToolUse)',
    )
    .action(codexHookAction);
