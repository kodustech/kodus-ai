import type { StepView } from '@libs/agent-harness/domain/contracts/policy.contract';

import { CONVERSATION_DECISION_TOOL } from './conversation-decision';
import { createWriteAuthorization } from './write-authorization';
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

const build = () => {
    const authorization = createWriteAuthorization();
    return {
        authorization,
        policy: new WriteGatePolicy(DEVELOPER_MESSAGE, authorization),
    };
};

const policy = () => build().policy;

describe('WriteGatePolicy', () => {
    it('leaves the tools in front of the agent — it never hides them', () => {
        expect(policy().prepareStep(view())?.activeTools).toBeUndefined();
    });

    it('authorizes an act the developer asked for', () => {
        const { policy, authorization } = build();

        policy.prepareStep(
            view({
                intent: 'act',
                tool: 'KODUS_CREATE_MEMORY',
                authorizingQuote: 'save that as a memory',
            }),
        );

        expect(authorization.allows('KODUS_CREATE_MEMORY')).toBe(true);
    });

    it('authorizes nothing when the agent only means to offer', () => {
        const { policy, authorization } = build();

        policy.prepareStep(
            view({ intent: 'offer', tool: 'KODUS_CREATE_MEMORY' }),
        );

        expect(authorization.allows('KODUS_CREATE_MEMORY')).toBe(false);
    });

    it('refuses an act whose quote the developer never wrote', () => {
        const { policy, authorization } = build();

        const directives = policy.prepareStep(
            view({
                intent: 'act',
                tool: 'KODUS_CREATE_MEMORY',
                authorizingQuote: 'delete everything',
            }),
        );

        expect(authorization.allows('KODUS_CREATE_MEMORY')).toBe(false);
        expect(directives.emit?.[0]?.kind).toBe('write-gate.unauthorized');
    });

    it('refuses an act with no quote at all', () => {
        const { policy, authorization } = build();

        policy.prepareStep(
            view({ intent: 'act', tool: 'KODUS_CREATE_MEMORY' }),
        );

        expect(authorization.allows('KODUS_CREATE_MEMORY')).toBe(false);
    });

    it('says what it wants while the gate is shut, so the reply still offers', () => {
        const note = policy().prepareStep(view())?.injectNote?.content ?? '';

        expect(note).toMatch(new RegExp(CONVERSATION_DECISION_TOOL));
        expect(note).toMatch(/quote/i);
    });
});
