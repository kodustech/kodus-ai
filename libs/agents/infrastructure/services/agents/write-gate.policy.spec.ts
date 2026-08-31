import type { StepView } from '@libs/agent-harness/domain/contracts/policy.contract';

import { CONVERSATION_DECISION_TOOL } from './conversation-decision';
import { WriteGatePolicy } from './write-gate.policy';

const DEVELOPER_MESSAGE = '@kody yes, please save that as a memory.';

const view = (decision?: Record<string, unknown>): StepView =>
    ({
        runId: 'r',
        agentId: 'conversation',
        stepNumber: 1,
        maxSteps: 12,
        steps: decision
            ? [
                  {
                      index: 0,
                      message: {
                          role: 'assistant',
                          content: '',
                          toolCalls: [
                              {
                                  id: 'c1',
                                  name: CONVERSATION_DECISION_TOOL,
                                  input: decision,
                              },
                          ],
                      },
                  },
              ]
            : [],
        messages: [],
        activeTools: [
            'KODUS_FIND_MEMORIES',
            'KODUS_CREATE_MEMORY',
            CONVERSATION_DECISION_TOOL,
            'grep',
        ],
    }) as StepView;

const policy = () =>
    new WriteGatePolicy(
        (name) => name === 'KODUS_CREATE_MEMORY',
        DEVELOPER_MESSAGE,
    );

describe('WriteGatePolicy', () => {
    it('keeps the write tools out until the agent commits to acting', () => {
        const active = policy().prepareStep(view())?.activeTools;

        expect(active).not.toContain('KODUS_CREATE_MEMORY');
        // Everything else stays — it must still answer, read and decide.
        expect(active).toEqual(
            expect.arrayContaining([
                'KODUS_FIND_MEMORIES',
                CONVERSATION_DECISION_TOOL,
                'grep',
            ]),
        );
    });

    it('opens the gate for an act the developer authorized', () => {
        const directives = policy().prepareStep(
            view({
                intent: 'act',
                tool: 'KODUS_CREATE_MEMORY',
                authorizingQuote: 'save that as a memory',
            }),
        );

        expect(directives.activeTools).toBeUndefined();
    });

    it('keeps it shut when the agent only means to offer', () => {
        const active = policy().prepareStep(
            view({ intent: 'offer', tool: 'KODUS_CREATE_MEMORY' }),
        )?.activeTools;

        expect(active).not.toContain('KODUS_CREATE_MEMORY');
    });

    it('refuses an act whose quote the developer never wrote', () => {
        const directives = policy().prepareStep(
            view({
                intent: 'act',
                tool: 'KODUS_CREATE_MEMORY',
                authorizingQuote: 'delete everything',
            }),
        );

        expect(directives.activeTools).not.toContain('KODUS_CREATE_MEMORY');
        expect(directives.emit?.[0]?.kind).toBe('write-gate.unauthorized');
    });

    it('refuses an act with no quote at all', () => {
        const active = policy().prepareStep(
            view({ intent: 'act', tool: 'KODUS_CREATE_MEMORY' }),
        )?.activeTools;

        expect(active).not.toContain('KODUS_CREATE_MEMORY');
    });

    it('says what it wants while the gate is shut, so the reply still offers', () => {
        const note = policy().prepareStep(view())?.injectNote?.content ?? '';

        expect(note).toMatch(new RegExp(CONVERSATION_DECISION_TOOL));
        expect(note).toMatch(/quote/i);
    });

    it('keeps its own mechanics out of what the developer reads', () => {
        const note = policy().prepareStep(view())?.injectNote?.content ?? '';

        // The first gate told the model its tools were "unavailable" and the
        // model dutifully relayed that to the developer, who does not care.
        expect(note).not.toMatch(/unavailable/i);
        expect(note).toMatch(/never (?:tell|mention)/i);
    });
});
