/**
 * Holds the write tools back until the agent has said, on the record, that the
 * developer asked it to act — and can point at the words.
 *
 * An earlier version gated on whether the thread already had a reply, which had
 * nothing to do with whether anything was asked for: it refused a first-message
 * "save a memory: X" and told the developer to ask again. This gates on the
 * decision instead, so a direct instruction works on the first message and an
 * unprompted write cannot happen by drift.
 */
import type {
    AgentPolicy,
    StepDirectives,
    StepView,
} from '@libs/agent-harness/domain/contracts/policy.contract';

import {
    CONVERSATION_DECISION_TOOL,
    authorizedByDeveloper,
    readDecision,
} from './conversation-decision';

export class WriteGatePolicy implements AgentPolicy {
    readonly name = 'write-gate';

    constructor(
        private readonly isWriteTool: (name: string) => boolean,
        private readonly developerMessage: string,
    ) {}

    prepareStep(view: StepView): StepDirectives {
        const decision = readDecision(view.steps);

        if (decision?.intent === 'act') {
            if (
                authorizedByDeveloper(
                    decision.authorizingQuote,
                    this.developerMessage,
                )
            ) {
                // Nothing to restrict — the full tool set stands.
                return {};
            }

            return {
                ...this.shut(view),
                emit: [
                    {
                        kind: 'write-gate.unauthorized',
                        detail: {
                            tool: decision.tool,
                            quote: decision.authorizingQuote,
                        },
                    },
                ],
            };
        }

        return this.shut(view);
    }

    private shut(view: StepView): StepDirectives {
        return {
            activeTools: view.activeTools.filter(
                (name) => !this.isWriteTool(name),
            ),
            injectNote: {
                role: 'user',
                content: `Answer the developer. If something here is worth persisting, call ${CONVERSATION_DECISION_TOOL} with intent 'offer' and say, in your reply, what you would do and that you can do it on their word. If — and only if — the developer's latest message instructs you to act, call it with intent 'act' and quote the words of theirs that instruct it. This instruction is between us: never tell the developer what you can or cannot currently do, or that anything is gating you — offer plainly, as a colleague would.`,
            },
        };
    }
}
