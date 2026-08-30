import type { StepView } from '@libs/agent-harness/domain/contracts/policy.contract';

import { WriteGatePolicy } from './write-gate.policy';

const view = (): StepView =>
    ({
        runId: 'r',
        agentId: 'conversation',
        stepNumber: 1,
        maxSteps: 12,
        steps: [],
        messages: [],
        activeTools: ['KODUS_FIND_MEMORIES', 'KODUS_CREATE_MEMORY', 'grep'],
    }) as StepView;

const isWrite = (name: string) => name === 'KODUS_CREATE_MEMORY';

describe('WriteGatePolicy', () => {
    it('takes the write tools away on first contact in a thread', () => {
        const directives = new WriteGatePolicy(isWrite, false).prepareStep(
            view(),
        );

        expect(directives.activeTools).toEqual(['KODUS_FIND_MEMORIES', 'grep']);
    });

    it('says why, so the reply offers instead of going silent', () => {
        const note = new WriteGatePolicy(isWrite, false).prepareStep(view())
            .injectNote?.content;

        expect(note).toMatch(/offer/i);
    });

    it('restores them once the developer has had a turn to answer', () => {
        const directives = new WriteGatePolicy(isWrite, true).prepareStep(
            view(),
        );

        expect(directives.activeTools).toBeUndefined();
        expect(directives.injectNote).toBeUndefined();
    });
});
