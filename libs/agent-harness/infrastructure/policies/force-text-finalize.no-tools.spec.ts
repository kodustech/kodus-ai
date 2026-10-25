import { ForceTextFinalizePolicy } from './force-text-finalize.policy';
import type { StepView } from '../../domain/contracts/policy.contract';

const view = (stepNumber: number, maxSteps: number) =>
    ({
        stepNumber,
        maxSteps,
        activeTools: ['readFile'],
        steps: [],
        messages: [],
    }) as unknown as StepView;

describe('ForceTextFinalizePolicy noToolsOnLastStep', () => {
    const policy = new ForceTextFinalizePolicy({
        answerDescription: 'your final JSON verdict',
        noToolsOnLastStep: true,
    });

    it('takes the tools away only on the last step', () => {
        expect(policy.prepareStep(view(4, 5)).activeTools).toEqual([]);
        expect(policy.prepareStep(view(3, 5)).activeTools).toBeUndefined();
        expect(policy.prepareStep(view(3, 5)).injectNote).toBeDefined();
    });

    it('keeps the tools without the option', () => {
        const plain = new ForceTextFinalizePolicy({ answerDescription: 'x' });
        expect(plain.prepareStep(view(4, 5)).activeTools).toBeUndefined();
    });
});
