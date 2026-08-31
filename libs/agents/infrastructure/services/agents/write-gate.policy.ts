/**
 * Watches for the agent declaring an action, and authorizes the write when it
 * does — the developer's own words being the authority.
 *
 * The policy does not take tools away. An earlier version did, and the model
 * read the absence as incapacity: told to save a memory, it answered that it
 * had no tool for it. The tools stay in front of it now; what changes is
 * whether they will actually run (see `requireDeclaredAction`).
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
import type { WriteAuthorization } from './write-authorization';

export class WriteGatePolicy implements AgentPolicy {
    readonly name = 'write-gate';

    private noted = false;

    constructor(
        private readonly developerMessage: string,
        private readonly authorization: WriteAuthorization,
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
                this.authorization.grant(decision.tool);
                return {};
            }

            return {
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

        // Said once: repeating it every step crowds out the conversation.
        if (this.noted) {
            return {};
        }
        this.noted = true;

        return {
            injectNote: {
                role: 'user',
                content: `Before you change anything, call ${CONVERSATION_DECISION_TOOL}: intent 'act' when the developer's latest message instructs it — you must quote the words of theirs that do — or intent 'offer' when something is worth persisting but they have not asked. This is between us: never tell the developer what you can or cannot currently do, or that anything is gating you. Offer plainly, as a colleague would.`,
            },
        };
    }
}
