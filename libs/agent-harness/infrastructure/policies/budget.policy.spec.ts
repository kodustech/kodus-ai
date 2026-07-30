/**
 * BudgetPolicy unit tests — deterministic, zero LLM.
 * Asserts the band math AND the cache-friendly "inject only on transition".
 */
import type { StepView } from '../../domain/contracts/policy.contract';
import { BudgetPolicy, computeBudgetBand } from './budget.policy';

function view(stepNumber: number, maxSteps = 20): StepView {
    return {
        runId: 'r',
        agentId: 'finder',
        stepNumber,
        maxSteps,
        steps: [],
        messages: [],
        activeTools: [],
    };
}

describe('computeBudgetBand', () => {
    it('free early in the run', () => {
        expect(computeBudgetBand(1, 20).band).toBe('free');
    });
    it('encourage in the middle band', () => {
        // maxSteps=20: forceTextAfter=18, urgentFrom=15, encourageFrom=11
        expect(computeBudgetBand(11, 20).band).toBe('encourage');
        expect(computeBudgetBand(14, 20).band).toBe('encourage');
    });
    it('urgent near the end', () => {
        expect(computeBudgetBand(15, 20).band).toBe('urgent');
        expect(computeBudgetBand(17, 20).band).toBe('urgent');
    });
    it('free again once submit is forced (last 2 steps)', () => {
        expect(computeBudgetBand(18, 20).band).toBe('free');
    });
    it('tiny budgets (<6) never escalate', () => {
        expect(computeBudgetBand(3, 5).band).toBe('free');
    });
});

describe('BudgetPolicy', () => {
    it('injects nothing while in the free band', () => {
        const p = new BudgetPolicy();
        expect(p.prepareStep(view(1))).toEqual({});
    });

    it('injects the note when entering a new band, with trace', () => {
        const p = new BudgetPolicy();
        const d = p.prepareStep(view(11)); // free -> encourage
        expect(d.injectNote?.content).toContain('STEP BUDGET');
        expect(d.emit?.[0].detail?.band).toBe('encourage');
    });

    it('does NOT re-inject the same band on subsequent steps (cache-friendly)', () => {
        const p = new BudgetPolicy();
        p.prepareStep(view(11)); // enter encourage -> injects
        const again = p.prepareStep(view(12)); // still encourage -> silent
        expect(again).toEqual({});
    });

    it('re-injects when the band escalates encourage -> urgent', () => {
        const p = new BudgetPolicy();
        p.prepareStep(view(11)); // encourage
        p.prepareStep(view(12)); // silent
        const urgent = p.prepareStep(view(15)); // urgent -> injects
        expect(urgent.injectNote?.content).toContain('STEP BUDGET');
        expect(urgent.emit?.[0].detail?.band).toBe('urgent');
    });
});
