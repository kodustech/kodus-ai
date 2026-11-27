import type { StepView } from '@libs/agent-harness/domain/contracts/policy.contract';

import { WriteTruthPolicy } from './write-truth.policy';

// The steps list every call the model made, refused ones included; the note
// must not read them.
const view = (names: string[]): StepView =>
    ({
        runId: 'r',
        agentId: 'conversation',
        stepNumber: 1,
        maxSteps: 12,
        steps: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content: '',
                    toolCalls: names.map((name, i) => ({ id: `c${i}`, name, input: {} })),
                },
            },
        ],
        messages: [],
        activeTools: [],
    }) as StepView;

const note = (performed: string[], called: string[] = performed) =>
    new WriteTruthPolicy(() => performed).prepareStep(view(called))?.injectNote?.content ?? '';

describe('WriteTruthPolicy', () => {
    it('tells the model it has done nothing when no write ran', () => {
        expect(note([])).toMatch(/none/i);
        expect(note([])).toMatch(/do not say you saved/i);
    });

    it('constrains the claim without nudging the model to act', () => {
        expect(note([])).toMatch(/only once its tool call has returned/i);
        // Whether to act is the prompt's rule, not this note's business —
        // encouraging it here made the agent write without being asked.
        expect(note([])).not.toMatch(/call the tool now/i);
    });

    it('names the writes that did run, once each', () => {
        expect(note(['KODUS_CREATE_MEMORY', 'KODUS_CREATE_MEMORY'])).toContain(
            'ACTIONS PERFORMED THIS TURN: KODUS_CREATE_MEMORY. Report these',
        );
    });

    // Kimi K2.7 told the developer "Done! I've saved that as a memory" after
    // the gate refused the save: the note had listed the refused call.
    it('does not report a write the gate refused', () => {
        expect(note([], ['kodus_save_memory'])).toContain('ACTIONS PERFORMED THIS TURN: none.');
    });
});
