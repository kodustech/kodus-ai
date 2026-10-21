import type { StepView } from '@libs/agent-harness/domain/contracts/policy.contract';

import { WriteTruthPolicy } from './write-truth.policy';

const view = (toolCalls: Array<{ name: string }>): StepView =>
    ({
        runId: 'r',
        agentId: 'conversation',
        stepNumber: 1,
        maxSteps: 12,
        steps: toolCalls.length
            ? [
                  {
                      index: 0,
                      message: {
                          role: 'assistant',
                          content: '',
                          toolCalls: toolCalls.map((t, i) => ({
                              id: `c${i}`,
                              name: t.name,
                              input: {},
                          })),
                      },
                  },
              ]
            : [],
        messages: [],
        activeTools: [],
    }) as StepView;

describe('WriteTruthPolicy', () => {
    const policy = new WriteTruthPolicy(
        (name) =>
            name.startsWith('KODUS_CREATE') || name.startsWith('KODUS_UPDATE'),
    );

    it('tells the model it has done nothing when no write ran', () => {
        const note = policy.prepareStep(view([]))?.injectNote?.content ?? '';

        expect(note).toMatch(/none/i);
        expect(note).toMatch(/do not say you saved/i);
    });

    it('constrains the claim without nudging the model to act', () => {
        const note = policy.prepareStep(view([]))?.injectNote?.content ?? '';

        expect(note).toMatch(/only once its tool call has returned/i);
        // Whether to act is the prompt's rule, not this note's business —
        // encouraging it here made the agent write without being asked.
        expect(note).not.toMatch(/call the tool now/i);
    });

    it('names the writes that did run', () => {
        const note =
            policy.prepareStep(view([{ name: 'KODUS_CREATE_MEMORY' }]))
                ?.injectNote?.content ?? '';

        expect(note).toContain('KODUS_CREATE_MEMORY');
    });

    it('ignores read tools when deciding what was done', () => {
        const note =
            policy.prepareStep(view([{ name: 'KODUS_FIND_MEMORIES' }]))
                ?.injectNote?.content ?? '';

        expect(note).toMatch(/none/i);
    });
});
