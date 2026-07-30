/**
 * agent-harness — ForceFinalizePolicy.
 *
 * Ports the legacy loop's "force-text" mechanism into a clean policy: in the
 * last few steps before maxSteps, restrict the active tools to ONLY the done
 * tool, so the model is compelled to submit its result instead of investigating
 * until it runs out of steps with nothing submitted — which would throw away all
 * of its work (0 findings). This is correctness, not extra recall.
 *
 * It is the first real consumer of the `activeTools` seam (previously dormant).
 * Unit-testable with zero LLM: feed a StepView, assert the directive.
 */
import type {
    AgentPolicy,
    StepDirectives,
    StepView,
} from '../../domain/contracts/policy.contract';

export interface ForceFinalizePolicyOptions {
    /** The finalize/submit tool the agent must call to produce its result. */
    readonly doneToolName: string;
    /** Force within this many steps of maxSteps. Default 2 (mirrors legacy). */
    readonly withinLastSteps?: number;
}

export class ForceFinalizePolicy implements AgentPolicy {
    readonly name = 'force-finalize';

    constructor(private readonly opts: ForceFinalizePolicyOptions) {}

    prepareStep(view: StepView): StepDirectives {
        const within = this.opts.withinLastSteps ?? 2;
        if (view.stepNumber < view.maxSteps - within) {
            return {};
        }
        // Only the done tool is active → the model can do nothing but finalize.
        return {
            activeTools: [this.opts.doneToolName],
            injectNote: {
                role: 'user',
                content: `You are at the final step. Call ${this.opts.doneToolName} now with the findings you have — do not investigate further.`,
            },
            emit: [
                {
                    kind: 'force-finalize',
                    detail: {
                        stepNumber: view.stepNumber,
                        maxSteps: view.maxSteps,
                    },
                },
            ],
        };
    }
}
