import { cursorAgent } from '../../../agents/cursor.agent.js';
import { handleHook } from './shared.js';
import type { CursorHookEvent } from '../../../types/session.js';

const VALID_HOOKS: Set<CursorHookEvent> = new Set([
    'sessionStart',
    'sessionEnd',
    'stop',
    'beforeSubmitPrompt',
    'subagentStart',
    'subagentStop',
]);

export async function cursorHookAction(hookName: string): Promise<void> {
    if (!VALID_HOOKS.has(hookName as CursorHookEvent)) {
        if (process.env.KODUS_VERBOSE === 'true') {
            console.error(`[decisions] unknown Cursor hook: ${hookName}`);
        }
        return;
    }

    await handleHook(cursorAgent, hookName);
}
