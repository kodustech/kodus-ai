/**
 * Ends a run that keeps recording decisions instead of answering.
 *
 * `kodusDecideAction` is meant to be called once per reply. Some models call
 * it on every step and never write the answer: 262 of 2,924 conversations on
 * 26 Nov 2026 ran to the 12-step limit doing only that, then fell back to a
 * second, minimal run. Past MAX_DECISIONS the tool itself tells the agent to
 * answer (see buildDecisionTool); a run that records STOP_AFTER_DECISIONS
 * decisions with no other tool call in between stops here, and the minimal
 * run answers without the wasted steps. Decisions separated by reads or
 * writes are a run at work, not this loop.
 *
 * The policy never removes the tool from the step: a changed tool list makes
 * Anthropic reject every earlier thinking block of the run (#2731). Stopping
 * and answering through a tool result keep the history append-only.
 */
import type {
    AgentPolicy,
    StepView,
} from '@libs/agent-harness/domain/contracts/policy.contract';

import {
    decisionsSinceOtherWork,
    MAX_DECISIONS,
} from './conversation-decision';

/** Two told-to-answer calls past MAX_DECISIONS, then the run ends. */
export const STOP_AFTER_DECISIONS = MAX_DECISIONS + 2;

export class DecisionLoopPolicy implements AgentPolicy {
    readonly name = 'decision-loop';

    shouldStop(view: StepView): boolean {
        return decisionsSinceOtherWork(view.steps) >= STOP_AFTER_DECISIONS;
    }
}
