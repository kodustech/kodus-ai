import {
    buildDecisionTool,
    CONVERSATION_DECISION_TOOL,
} from './conversation-decision';
import { DecisionLoopPolicy } from './decision-loop.policy';

const step = (call: Record<string, unknown>) =>
    ({ message: { toolCalls: [{ name: CONVERSATION_DECISION_TOOL, ...call }] } }) as any;
const decided = () => step({ input: { intent: 'answer' } });
const view = (steps: any[]) => ({ steps }) as any;

/**
 * Some models recorded a decision on every step and never answered, until the
 * 12-step limit (9% of conversations, Nov 2026). The tool tells the agent to
 * answer after two decisions, and the run ends after four. The tool list never
 * changes: Anthropic rejects earlier thinking blocks when it does (#2731).
 */
describe('decision loop', () => {
    const policy = new DecisionLoopPolicy();

    it('lets the run go on through three decisions', () => {
        expect(policy.shouldStop(view([decided(), decided(), decided()]))).toBe(false);
    });

    it('stops the run at the fourth decision', () => {
        expect(
            policy.shouldStop(view([decided(), decided(), decided(), decided()])),
        ).toBe(true);
    });

    it('does not count a call that failed or did not parse', () => {
        const failed = step({ input: { intent: 'answer' }, isError: true });
        const invalid = step({ input: { intent: 'shout' } });
        expect(
            policy.shouldStop(view([failed, invalid, decided(), decided(), decided()])),
        ).toBe(false);
    });

    it('answers "noted" twice, then tells the agent to reply', async () => {
        const tool: any = buildDecisionTool()[CONVERSATION_DECISION_TOOL];
        const answers = [];
        for (let i = 0; i < 3; i++) {
            answers.push(await tool.execute({ intent: 'answer' }, {}));
        }
        expect(answers).toEqual([
            'noted',
            'noted',
            'Your decision is already recorded. Do not call kodusDecideAction again: write your reply to the developer now.',
        ]);
    });

    it('does not count a malformed call toward the limit', async () => {
        const tool: any = buildDecisionTool()[CONVERSATION_DECISION_TOOL];
        await tool.execute({ intent: 'shout' }, {});
        await tool.execute({ intent: 'answer' }, {});
        expect(await tool.execute({ intent: 'answer' }, {})).toBe('noted');
    });
});
