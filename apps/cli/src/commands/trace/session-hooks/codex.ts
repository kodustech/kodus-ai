import { codexAgent } from '../../../agents/codex.agent.js';
import { handleHook } from './shared.js';
import type { CodexHookEvent } from '../../../types/session.js';

const VALID_HOOKS: Set<CodexHookEvent> = new Set([
    'AfterAgent',
    'AfterToolUse',
]);

export async function codexHookAction(hookName: string): Promise<void> {
    if (!VALID_HOOKS.has(hookName as CodexHookEvent)) {
        if (process.env.KODUS_VERBOSE === 'true') {
            console.error(`[decisions] unknown Codex hook: ${hookName}`);
        }
        return;
    }

    await handleHook(codexAgent, hookName);
}
