/**
 * agent-harness — ForceTextFinalizePolicy.
 *
 * The legacy loop's "force-text" as it actually was: near maxSteps, TELL the
 * model to deliver its answer now — and leave its tools alone.
 *
 * Why this exists next to {@link ForceFinalizePolicy}: that one restricts
 * `activeTools` to the done tool, so the model can do nothing but call it. That
 * is right for an agent whose contract IS the tool (the finder). It is wrong for
 * one whose contract is TEXT, and the verifier is exactly that — its prompt hands
 * the model a JSON schema and says "Return a final JSON verdict", and never
 * mentions the done tool. Forcing the tool there would contradict the prompt
 * mid-run, and constraining this output is measured harm: `model-strictness.ts`
 * records native strict tool use halving recall (0.357 -> 0.100) and declares the
 * text fallback the intended channel for Anthropic and the OpenAI-compatible
 * providers, which is most of the fleet.
 *
 * The failure it removes: a verify run that spends every step investigating and
 * is cut off with no verdict at all. Measured on 2026-09-19 over 154 production
 * verifier runs — 31 (20%) produced no verdict, and 16 of 24 sampled died on the
 * final step still calling tools. The gate then fails open and keeps the
 * candidate, so the verifier is a no-op for that fifth of the fleet.
 *
 * Boundary: mirrors `computeBudgetBand`'s `forceTextAfter = maxSteps - 2`, where
 * BudgetPolicy deliberately goes quiet ('free') because a finalize policy is
 * expected to take over. That hand-off is why BudgetPolicy's `maxSteps < 6`
 * short-circuit is not itself the bug: at maxSteps 5 the first two steps really
 * are free — what was missing is this policy covering the last three.
 *
 * Unit-testable with zero LLM: feed a StepView, assert the directive.
 */
import type {
    AgentPolicy,
    StepDirectives,
    StepView,
} from '../../domain/contracts/policy.contract';

export interface ForceTextFinalizePolicyOptions {
    /** What the model must produce, named the way its prompt names it (e.g.
     *  'your final JSON verdict'). Goes verbatim into the injected note. */
    readonly answerDescription: string;
    /** Nudge within this many steps of maxSteps. Default 2 — the same boundary
     *  BudgetPolicy hands off at (`maxSteps - 2`). */
    readonly withinLastSteps?: number;
}

export class ForceTextFinalizePolicy implements AgentPolicy {
    readonly name = 'force-text-finalize';

    constructor(private readonly opts: ForceTextFinalizePolicyOptions) {}

    prepareStep(view: StepView): StepDirectives {
        const within = this.opts.withinLastSteps ?? 2;
        if (view.stepNumber < view.maxSteps - within) {
            return {};
        }
        // NOTE, not a tool gate: the model may still investigate if it judges it
        // necessary. The only thing this removes is the excuse for ending with
        // nothing. Deliberately returns no `activeTools` — see the header.
        return {
            injectNote: {
                role: 'user',
                content: `You are on step ${view.stepNumber} of ${view.maxSteps}. Give ${this.opts.answerDescription} now, in your reply, from the evidence you already have. Do not open a new line of investigation.`,
            },
            emit: [
                {
                    kind: 'force-text-finalize',
                    detail: {
                        stepNumber: view.stepNumber,
                        maxSteps: view.maxSteps,
                    },
                },
            ],
        };
    }
}
