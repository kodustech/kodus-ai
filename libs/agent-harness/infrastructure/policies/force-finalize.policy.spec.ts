import type { StepView } from '../../domain/contracts/policy.contract';
import { ForceFinalizePolicy } from './force-finalize.policy';

const view = (stepNumber: number, maxSteps: number): StepView => ({
    runId: 'r',
    agentId: 'finder',
    stepNumber,
    maxSteps,
    steps: [],
    messages: [],
    activeTools: ['grep', 'readFile', 'submitResult'],
});

describe('ForceFinalizePolicy', () => {
    const p = new ForceFinalizePolicy({ doneToolName: 'submitResult' });

    it('does nothing before the last 2 steps', () => {
        expect(p.prepareStep(view(0, 20))).toEqual({});
        expect(p.prepareStep(view(17, 20))).toEqual({});
    });

    it('restricts to ONLY the done tool in the last 2 steps', () => {
        const d = p.prepareStep(view(18, 20));
        expect(d.activeTools).toEqual(['submitResult']);
        expect(d.injectNote?.content).toContain('submitResult');
        expect(d.emit?.[0].kind).toBe('force-finalize');
    });

    it('honors a custom withinLastSteps', () => {
        const p3 = new ForceFinalizePolicy({
            doneToolName: 'submitResult',
            withinLastSteps: 3,
        });
        expect(p3.prepareStep(view(16, 20))).toEqual({});
        expect(p3.prepareStep(view(17, 20)).activeTools).toEqual([
            'submitResult',
        ]);
    });
});
