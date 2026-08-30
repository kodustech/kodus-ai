/**
 * Audit seam for the conversation agent's mutating tools.
 *
 * The agent may now propose actions, so a turn can change org-level state
 * (memories, rules, issues). Every such call is reported before it is answered
 * for, including the destructive tools the agent is never told to offer — those
 * are exactly the ones worth seeing in a log.
 *
 * Which tools those are is NOT listed here: it comes from each tool's own MCP
 * `readOnlyHint`. A tool that does not declare one is treated as a write, so a
 * server that omits its annotations is over-logged rather than silently
 * unaudited.
 */
import type { Tool } from 'ai';

import type { McpToolMetadata } from '../ai-sdk/mcp-tools';

export interface WriteToolEvent {
    tool: string;
    args: unknown;
    /** Present when the tool threw; the error is re-thrown either way. */
    error?: string;
}

export function isConversationWriteTool(
    metadata: McpToolMetadata | undefined,
): boolean {
    return metadata?.readOnlyHint !== true;
}

/**
 * Return the tool map with every write tool wrapped so `onWrite` sees the call.
 * Read tools are passed through by reference — nothing to audit, nothing to pay.
 */
export function auditWriteTools(
    tools: Record<string, Tool>,
    metadata: Record<string, McpToolMetadata>,
    onWrite: (event: WriteToolEvent) => void,
): Record<string, Tool> {
    const audited: Record<string, Tool> = {};

    for (const [name, tool] of Object.entries(tools)) {
        if (
            !isConversationWriteTool(metadata[name]) ||
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
