/**
 * agent-harness — CompletionGatePolicy (the H-STOP experiment, as a composable policy).
 *
 * Extracted from the 4600-line legacy loop's inlined `stopWhen` gate. This is
 * the finder's SUBMISSION policy: it owns the "may the agent finalize?"
 * decision.
 *
 * Behavior (faithful to H-STOP):
 *  - prepareStep: inject the progress debt so the model is steered to the
 *    unaddressed critical targets (mechanism, not finder-prompt text).
 *  - onStepFinish: mark progress from the tools the agent just called.
 *  - shouldStop: honor the done tool ONLY when no CRITICAL target remains
 *    pending. Never requires 100% (that is the #5 exhaustive trap). The
 *    runner's stepCountIs(maxSteps) is the fail-open.
 *
 * Domain-agnostic: the diff-hunk specifics live in the injected ProgressLedger.
 * Unit-testable with zero LLM: feed a StepView + a fake ledger, assert.
 */
import type { ProgressLedger } from '../../domain/contracts/progress.contract';
import type {
    AgentPolicy,
    StepDirectives,
    StepView,
} from '../../domain/contracts/policy.contract';

export interface CompletionGatePolicyOptions {
    /** Name of the submission/finalize tool the agent calls to finish. */
    readonly doneToolName: string;
}

export class CompletionGatePolicy implements AgentPolicy {
    readonly name = 'completion-gate';

    constructor(
        private readonly ledger: ProgressLedger,
        private readonly opts: CompletionGatePolicyOptions,
    ) {}

    prepareStep(_view: StepView): StepDirectives {
        const note = this.ledger.debtNote();

        if (!note) {
            return {};
        }

        const s = this.ledger.summary();
        return {
            // role MUST be 'user': this note is injected mid-conversation and
            // providers like Google Gemini reject system messages outside the
            // first position. (The runner's mergeDirectives also coerces this,
            // but keep it correct at the source.)
            injectNote: {
                role: 'user',
                content: `${note}\nPrioritize the pending critical targets before anything else.`,
            },
            emit: [
                {
                    kind: 'progress.debt',
                    detail: {
                        criticalPending: s.criticalPending,
                        criticalTotal: s.criticalTotal,
                        pending: s.pendingTargets,
                    },
                },
            ],
        };
    }

    onStepFinish(view: StepView): void {
        const last = view.steps[view.steps.length - 1];

        if (!last) {
            return;
        }

        for (const tc of last.message.toolCalls ?? []) {
            this.ledger.markFromToolCall(tc.name, tc.input, last.index);
        }
    }

    shouldStop(view: StepView): boolean {
        const last = view.steps[view.steps.length - 1];
        const doneCalled = (last?.message.toolCalls ?? []).some(
            (tc) => tc.name === this.opts.doneToolName,
        );
        if (!doneCalled) {
            return false;
        } // nothing to gate this step‰

        const s = this.ledger.summary();
        // Gate ONLY on critical-tier pending — never require all targets done.
        if (s.criticalTotal > 0 && s.criticalPending > 0) {
            return false; // veto the finalize: keep investigating
        }
        return true; // honor done
    }
}
