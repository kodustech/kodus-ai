/**
 * Audit seam for the conversation agent's mutating tools.
 *
 * The agent may now propose actions, so a turn can change org-level state
 * (memories, rules, issues). Every such call is reported before it is answered
 * for, including the destructive tools the agent is never told to offer — those
 * are exactly the ones worth seeing in a log.
 */
import type { Tool } from 'ai';

/** Kodus MCP tools that mutate state. Matched by name, as MCP exposes them. */
const WRITE_TOOLS = new Set([
    'KODUS_CREATE_MEMORY',
    'KODUS_CREATE_KODY_RULE',
    'KODUS_UPDATE_KODY_RULE',
    'KODUS_DELETE_KODY_RULE',
    'KODUS_CREATE_KODY_ISSUE',
    'KODUS_UPDATE_KODY_ISSUE_STATUS',
    'KODUS_UPDATE_KODY_ISSUE_CATEGORY',
    'KODUS_DELETE_KODY_ISSUE',
]);

export interface WriteToolEvent {
    tool: string;
    args: unknown;
    /** Present when the tool threw; the error is re-thrown either way. */
    error?: string;
}

export function isConversationWriteTool(name: string): boolean {
    return WRITE_TOOLS.has(name);
}

/**
 * Return the tool map with every write tool wrapped so `onWrite` sees the call.
 * Read tools are passed through by reference — nothing to audit, nothing to pay.
 */
export function auditWriteTools(
    tools: Record<string, Tool>,
    onWrite: (event: WriteToolEvent) => void,
): Record<string, Tool> {
    const audited: Record<string, Tool> = {};

    for (const [name, tool] of Object.entries(tools)) {
        if (
            !isConversationWriteTool(name) ||
            typeof tool.execute !== 'function'
        ) {
            audited[name] = tool;
            continue;
        }

        const execute = tool.execute.bind(tool);
        audited[name] = {
            ...tool,
            execute: async (args: never, options: never) => {
                try {
                    const result = await execute(args, options);
                    onWrite({ tool: name, args });
                    return result;
                } catch (error) {
                    onWrite({
                        tool: name,
                        args,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                    throw error;
                }
            },
        } as Tool;
    }

    return audited;
}
