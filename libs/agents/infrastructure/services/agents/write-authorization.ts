/**
 * Refuses a write that nobody declared — at execution, not by hiding the tool.
 *
 * Hiding it was the first attempt, and it backfired: the model looked at what
 * it had, concluded "I don't have a tool to save memories", and told the
 * developer it couldn't help — even when the developer had just asked it to.
 * Reasoning from what it observes beats any instruction telling it otherwise.
 *
 * So the tools stay visible. A write that has not been authorized returns a
 * refusal explaining how to get authorized, which the model can act on in the
 * same turn. The guarantee is unchanged — nothing reaches org state without a
 * declared, quoted action — but the failure mode is now a retry instead of a
 * dead end.
 */
import type { Tool } from 'ai';

import { CONVERSATION_DECISION_TOOL } from './conversation-decision';

export interface WriteAuthorization {
    /** Allow writes; `tool` narrows it to the one that was declared. */
    grant(tool: string | undefined): void;
    allows(tool: string): boolean;
}

export function createWriteAuthorization(): WriteAuthorization {
    let granted = false;
    let grantedTool: string | undefined;

    return {
        grant(tool) {
            granted = true;
            grantedTool = tool;
        },
        allows(tool) {
            return granted && (!grantedTool || grantedTool === tool);
        },
    };
}

const REFUSAL =
    `This action has NOT been performed. Before changing anything you must call ${CONVERSATION_DECISION_TOOL} ` +
    `with intent 'act', naming this tool and quoting the words the developer used to instruct it. ` +
    `If they did not instruct it, do not act — call ${CONVERSATION_DECISION_TOOL} with intent 'offer' and offer it to them instead.`;

export function requireDeclaredAction(
    tools: Record<string, Tool>,
    isWriteTool: (name: string) => boolean,
    authorization: WriteAuthorization,
): Record<string, Tool> {
    const guarded: Record<string, Tool> = {};

    for (const [name, tool] of Object.entries(tools)) {
        if (!isWriteTool(name) || typeof tool.execute !== 'function') {
            guarded[name] = tool;
            continue;
        }

        const execute = tool.execute.bind(tool);
        guarded[name] = {
            ...tool,
            execute: async (args: never, options: never) =>
                authorization.allows(name) ? execute(args, options) : REFUSAL,
        } as Tool;
    }

    return guarded;
}
