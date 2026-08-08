import { gitService } from '../../../services/git.service.js';
import { lifecycleService } from '../../../services/lifecycle.service.js';
import { hookLogger } from '../../../services/hook-logger.service.js';
import type { AgentAdapter } from '../../../agents/agent.interface.js';
import { readStreamPayload } from '../../../utils/stream-input.js';

/**
 * Shared hook handler — reads payload from stdin, parses via agent adapter,
 * dispatches to the lifecycle service.
 */
export async function handleHook(
    agent: AgentAdapter,
    hookName: string,
): Promise<void> {
    try {
        const isRepo = await gitService.isGitRepository();
        if (!isRepo) {
            return;
        } // Fail open

        const repoRoot = (await gitService.getGitRoot()).trim();
        const rawPayload = await readStdinPayload();
        const payload = parsePayload(rawPayload);

        const event = agent.parseHookEvent(hookName, payload);
        if (!event) {
            await hookLogger.init(repoRoot);
            await hookLogger.warn('unrecognized-hook', 'hooks', {
                agent: agent.agentType,
                hook: hookName,
            });
            return;
        }

        await lifecycleService.dispatch(repoRoot, agent.agentType, event);
    } catch (error) {
        // Hooks must fail open — never block the agent.
        if (process.env.KODUS_VERBOSE === 'true') {
            const message =
                error instanceof Error ? error.message : String(error);
            console.error(`[decisions] hook error: ${message}`);
        }
    }
}

async function readStdinPayload(): Promise<string> {
    return readStreamPayload(process.stdin);
}

function parsePayload(raw: string): unknown {
    const trimmed = raw.trim();
    if (!trimmed) {
        return {};
    }

    try {
        return JSON.parse(trimmed) as unknown;
    } catch {
        return { raw_payload: trimmed };
    }
}
