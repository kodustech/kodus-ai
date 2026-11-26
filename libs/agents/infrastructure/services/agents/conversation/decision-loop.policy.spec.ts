import { CONVERSATION_DECISION_TOOL } from './conversation-decision';
import { DecisionLoopPolicy, MAX_DECISIONS } from './decision-loop.policy';

const decisionStep = () =>
    ({
        message: {
            toolCalls: [{ name: CONVERSATION_DECISION_TOOL, input: { intent: 'answer' } }],
        },
    }) as any;

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
        expect(policy.prepareStep(view([decisionStep()]))).toEqual({});
    });

    it('removes only the decision tool once the agent decided twice', () => {
        const steps = Array.from({ length: MAX_DECISIONS }, decisionStep);
        const out = policy.prepareStep(view(steps));
        expect(out.activeTools).toEqual(['grep', 'readFile']);
    });

    it('counts decisions, not steps that used other tools', () => {
        const other = { message: { toolCalls: [{ name: 'grep', input: {} }] } } as any;
        expect(policy.prepareStep(view([decisionStep(), other, other]))).toEqual({});
    });
});
