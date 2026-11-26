import { CONVERSATION_DECISION_TOOL } from './conversation-decision';
import { DecisionLoopPolicy } from './decision-loop.policy';

const step = (call: Record<string, unknown>) =>
    ({ message: { toolCalls: [{ name: CONVERSATION_DECISION_TOOL, ...call }] } }) as any;
const decided = () => step({ input: { intent: 'answer' } });

const view = (steps: any[]) =>
    ({
        stepNumber: steps.length,
        maxSteps: 12,
        steps,
        messages: [],
        activeTools: ['grep', 'readFile', CONVERSATION_DECISION_TOOL],
    }) as any;

/**
 * Some models recorded a decision on every step and never answered, until the
 * 12-step limit (9% of conversations, Nov 2026). The policy lets the agent
 * decide and revise once, then takes the decision tool out of the next step.
 */
describe('DecisionLoopPolicy', () => {
    const policy = new DecisionLoopPolicy();

    it('leaves the tools alone for the first decision and one revision', () => {
        expect(policy.prepareStep(view([]))).toEqual({});
        expect(policy.prepareStep(view([decided()]))).toEqual({});
    });

    it('removes only the decision tool after exactly two decisions', () => {
        expect(policy.prepareStep(view([decided(), decided()]))).toEqual({
            activeTools: ['grep', 'readFile'],
            emit: [{ kind: 'decision-loop.stopped', detail: { decisions: 2 } }],
        });
    });

    it('does not count a call that failed or did not parse', () => {
        const failed = step({ input: { intent: 'answer' }, isError: true });
        const invalid = step({ input: { intent: 'shout' } });
        expect(policy.prepareStep(view([failed, invalid, decided()]))).toEqual({});
    });

    it('does not count steps that used other tools', () => {
        const other = { message: { toolCalls: [{ name: 'grep', input: {} }] } } as any;
        expect(policy.prepareStep(view([decided(), other, other]))).toEqual({});
    });
});
