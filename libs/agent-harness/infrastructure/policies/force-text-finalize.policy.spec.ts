import { ForceTextFinalizePolicy } from './force-text-finalize.policy';

const view = (stepNumber: number, maxSteps: number) =>
    ({
        runId: 'r',
        agentId: 'verifier',
        stepNumber,
        maxSteps,
        steps: [],
        messages: [],
        activeTools: ['readFile', 'grep', 'submitVerdict'],
    }) as any;

describe('ForceTextFinalizePolicy', () => {
    const p = new ForceTextFinalizePolicy({
        answerDescription: 'your final JSON verdict',
    });

    it('stays silent while there is budget left', () => {
        for (const step of [1, 2]) {
            expect(p.prepareStep(view(step, 5))).toEqual({});
        }
        for (const step of [1, 5, 7]) {
            expect(p.prepareStep(view(step, 10))).toEqual({});
        }
    });

    it('nudges over the last steps, mirroring BudgetPolicy handoff (maxSteps-2)', () => {
        for (const step of [3, 4, 5]) {
            expect(p.prepareStep(view(step, 5)).injectNote?.content).toContain(
                'your final JSON verdict',
            );
        }
        for (const step of [8, 9, 10]) {
            expect(p.prepareStep(view(step, 10)).injectNote).toBeDefined();
        }
    });

    // The whole point: unlike ForceFinalizePolicy, the model keeps its tools.
    // Restricting them here would contradict a prompt that asks for text.
    it('never restricts the active tools', () => {
        for (const step of [3, 4, 5]) {
            expect(p.prepareStep(view(step, 5)).activeTools).toBeUndefined();
        }
    });

    it('states the step position so the note is actionable', () => {
        expect(p.prepareStep(view(5, 5)).injectNote?.content).toContain(
            'step 5 of 5',
        );
    });

    it('emits an observable trace event when it fires', () => {
        expect(p.prepareStep(view(5, 5)).emit).toEqual([
            {
                kind: 'force-text-finalize',
                detail: { stepNumber: 5, maxSteps: 5 },
            },
        ]);
        expect(p.prepareStep(view(1, 5)).emit).toBeUndefined();
    });

    it('honours a custom window', () => {
        const last = new ForceTextFinalizePolicy({
            answerDescription: 'the verdict',
            withinLastSteps: 1,
        });
        expect(last.prepareStep(view(3, 5))).toEqual({});
        expect(last.prepareStep(view(4, 5)).injectNote).toBeDefined();
    });
});
