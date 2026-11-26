/**
 * Stops the agent from recording decision after decision instead of answering.
 *
 * `kodusDecideAction` is meant to be called once per reply. Some models call
 * it again on every step and never write the answer: 262 of 2,924
 * conversations on 26 Nov 2026 ran to the 12-step limit doing only that, then
 * fell back to a second, minimal run. Once the agent has recorded the decision
 * MAX_DECISIONS times, the tool leaves the step's active set, so the next step
 * can only answer or use the other tools. It stays defined, so the calls
 * already in the history remain valid.
 */
import type {
    AgentPolicy,
    StepDirectives,
    StepView,
} from '@libs/agent-harness/domain/contracts/policy.contract';

import { CONVERSATION_DECISION_TOOL } from './conversation-decision';

/** One decision, plus one revision after reading more (e.g. answer → offer). */
export const MAX_DECISIONS = 2;

export class DecisionLoopPolicy implements AgentPolicy {
    readonly name = 'decision-loop';

    prepareStep(view: StepView): StepDirectives {
        const decisions = view.steps
            .flatMap((step) => step.message?.toolCalls ?? [])
            .filter((call) => call.name === CONVERSATION_DECISION_TOOL).length;
        if (decisions < MAX_DECISIONS) {
            return {};
        }
        return {
            activeTools: view.activeTools.filter(
                (name) => name !== CONVERSATION_DECISION_TOOL,
            ),
            emit: [{ kind: 'decision-loop.stopped', detail: { decisions } }],
        };
    }
}
