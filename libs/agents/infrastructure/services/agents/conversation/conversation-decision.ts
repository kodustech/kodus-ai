/**
 * The turn's decision, made explicit.
 *
 * Answering the developer, judging whether they asked for something, and
 * choosing to act were all happening inside one free-text generation, with no
 * point where the decision existed as something we could inspect or enforce.
 * It went wrong in both directions — writing unasked, and staying silent on a
 * thread that plainly revealed a convention.
 *
 * So the agent now has to commit: one call to `kodusDecideAction` naming what
 * it intends. The runner collects that call as the run's artifact (it is the
 * spec's `resultToolName`), the write gate reads it before letting any tool
 * change org state, and the provider compares it afterwards against what the
 * tools really did.
 */
import { jsonSchema, tool, type Tool } from 'ai';

import type { RunStep } from '@libs/agent-harness/domain/contracts/run-state.contract';

import type { WriteAuthorization } from './write-authorization';

export const CONVERSATION_DECISION_TOOL = 'kodusDecideAction';

export type ConversationIntent = 'answer' | 'offer' | 'act';

export interface ConversationDecision {
    intent: ConversationIntent;
    /** The write tool the agent intends to use, for `offer` and `act`. */
    tool?: string;
    /** For `act`: the developer's own words that authorize it. */
    authorizingQuote?: string;
    why?: string;
}

const INTENTS: readonly ConversationIntent[] = ['answer', 'offer', 'act'];

export function buildDecisionTool(
    onDecision?: (decision: ConversationDecision) => void,
): Record<string, Tool> {
    return {
        [CONVERSATION_DECISION_TOOL]: tool({
            description:
                'Record what you are about to do, before you do it. Call this exactly once per reply. ' +
                "Use intent 'answer' when the exchange needs no action, 'offer' when something is worth " +
                "persisting but the developer has not asked you to do it, and 'act' ONLY when the " +
                "developer's latest message instructs you to. For 'act' you must quote the words of " +
                'theirs that instruct it — you cannot act on your own reading of the situation.',
            inputSchema: jsonSchema({
                type: 'object',
                properties: {
                    intent: { type: 'string', enum: [...INTENTS] },
                    tool: {
                        type: 'string',
                        description: 'The write tool this concerns, if any.',
                    },
                    authorizingQuote: {
                        type: 'string',
                        description:
                            "Required for 'act': the developer's exact words instructing it.",
                    },
                    why: { type: 'string' },
                },
                required: ['intent'],
            }),
            // Reports the decision the moment it runs. The policy only sees
            // steps that have finished, so a model that emits the decision and
            // the write in a single message would otherwise have the write
            // refused and be told to declare something it just declared.
            execute: async (input: unknown) => {
                const decision = parse(input);
                if (decision) {
                    onDecision?.(decision);
                }
                return 'noted';
            },
        }),
    };
}

/** The decision the agent committed to this run, or undefined if it never did. */
export function readDecision(
    steps: readonly RunStep[],
): ConversationDecision | undefined {
    let decision: ConversationDecision | undefined;

    for (const step of steps) {
        for (const call of step.message?.toolCalls ?? []) {
            if (call.name !== CONVERSATION_DECISION_TOOL) {
                continue;
            }
            const parsed = parse(call.input);
            if (parsed) {
                decision = parsed;
            }
        }
    }

    return decision;
}

function parse(input: unknown): ConversationDecision | undefined {
    let raw = input;

    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch {
            return undefined;
        }
    }

    if (!raw || typeof raw !== 'object') {
        return undefined;
    }

    const value = raw as Record<string, unknown>;
    if (!INTENTS.includes(value.intent as ConversationIntent)) {
        return undefined;
    }

    return {
        intent: value.intent as ConversationIntent,
        ...(typeof value.tool === 'string' ? { tool: value.tool } : {}),
        ...(typeof value.authorizingQuote === 'string'
            ? { authorizingQuote: value.authorizingQuote }
            : {}),
        ...(typeof value.why === 'string' ? { why: value.why } : {}),
    };
}

/**
 * Whether the quote the agent offered as its authority is actually something
 * the developer wrote. Deliberately a plain containment check: it cannot tell
 * an instruction from an explanation, but it does stop the agent inventing an
 * authorization out of nothing, and every unlock carries a citation to review.
 */
export function authorizedByDeveloper(
    quote: string | undefined,
    developerMessage: string,
): boolean {
    const needle = quote?.trim().toLowerCase();

    if (!needle) {
        return false;
    }

    return developerMessage.toLowerCase().includes(needle);
}

/**
 * Authorize the write the agent declared, if the developer really asked for it.
 * The single place that decides — used both by the policy (between steps) and
 * by the decision tool itself (within a step), so the two cannot drift.
 */
export function grantIfAuthorized(
    decision: ConversationDecision | undefined,
    developerMessage: string,
    authorization: WriteAuthorization,
): boolean {
    if (decision?.intent !== 'act') {
        return false;
    }

    // An act that names no tool would otherwise grant every write on the run.
    if (!decision.tool) {
        return false;
    }

    if (!authorizedByDeveloper(decision.authorizingQuote, developerMessage)) {
        return false;
    }

    authorization.grant(decision.tool);
    return true;
}
