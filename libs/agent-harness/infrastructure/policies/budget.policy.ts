/**
 * agent-harness — BudgetPolicy (step-budget bands, extracted from the monolith's
 * computeStepBudgetNote).
 *
 * Pure, domain-agnostic, unit-testable. As the run approaches maxSteps it
 * injects escalating guidance (free -> encourage -> urgent) so the agent
 * synthesizes instead of opening new exploration threads near the end.
 *
 * Cache-friendly: a band note is injected ONLY on the step the band changes
 * (Gemini implicit prefix caching — re-injecting the same note every step
 * would invalidate the cache). The policy tracks the last emitted band.
 */
import type {
    AgentPolicy,
    StepDirectives,
    StepView,
} from '../../domain/contracts/policy.contract';

export type BudgetBand = 'free' | 'encourage' | 'urgent';

export function computeBudgetBand(
    stepNumber: number,
    maxSteps: number,
): { band: BudgetBand; note: string } {
    const forceTextAfter = maxSteps - 2;

    if (maxSteps < 6 || stepNumber >= forceTextAfter) {
        return { band: 'free', note: '' };
    }

    const urgentFrom = Math.max(forceTextAfter - 3, 3);
    const encourageFrom = Math.max(urgentFrom - 4, 2);

    if (stepNumber >= urgentFrom) {
        return {
            band: 'urgent',
            note: `STEP BUDGET: you are on step ${stepNumber}/${maxSteps}. Final steps before the submit is forced. Synthesize findings from the evidence already collected. Do NOT start new exploration threads unless verifying a specific named hypothesis.`,
        };
    }

    if (stepNumber >= encourageFrom) {
        return {
            band: 'encourage',
            note: `STEP BUDGET: you are on step ${stepNumber}/${maxSteps}. Start forming concrete hypotheses from the evidence collected so far. Avoid new reads unless they answer a specific question you can state upfront.`,
        };
    }

    return { band: 'free', note: '' };
}

export class BudgetPolicy implements AgentPolicy {
    readonly name = 'budget';
    private lastBand: BudgetBand = 'free';

    prepareStep(view: StepView): StepDirectives {
        const { band, note } = computeBudgetBand(
            view.stepNumber,
            view.maxSteps,
        );
        // Only inject when the band actually transitions (cache-friendly).
        if (band === this.lastBand || !note) {
            this.lastBand = band;
            return {};
        }

        this.lastBand = band;

        return {
            injectNote: { role: 'user', content: note },
            emit: [
                {
                    kind: 'budget.band',
                    detail: { band, step: view.stepNumber },
                },
            ],
        };
    }
}
