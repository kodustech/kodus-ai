import {
    buildDecisionTool,
    CONVERSATION_DECISION_TOOL,
    DECISION_LIMIT_NOTE,
    grantIfAuthorized,
} from './conversation-decision';
import { DecisionLoopPolicy } from './decision-loop.policy';
import { createWriteAuthorization } from './write-authorization';

const step = (...calls: Array<Record<string, unknown>>) => ({ message: { toolCalls: calls } }) as any;
const decision = (input: unknown) => ({ name: CONVERSATION_DECISION_TOOL, input });
const decided = () => step(decision({ intent: 'answer' }));
const read = () => step({ name: 'readFile', input: { path: 'a.ts' } });
const view = (steps: any[]) => ({ steps }) as any;

/**
 * Some models recorded a decision on every step and never answered, until the
 * 12-step limit (9% of conversations, Nov 2026): 11-12 steps of
 * kodusDecideAction alone. The tool tells the agent to answer after two
 * decisions, and the run ends after four in a row. The tool list never
 * changes: Anthropic rejects earlier thinking blocks when it does (#2731).
 */
describe('decision loop', () => {
    const policy = new DecisionLoopPolicy();

    it('lets the run go on through three decisions', () => {
        expect(policy.shouldStop(view([decided(), decided(), decided()]))).toBe(false);
    });

    it('stops the run at the fourth decision in a row', () => {
        expect(
            policy.shouldStop(view([decided(), decided(), decided(), decided()])),
        ).toBe(true);
    });

    it('does not count a call that did not parse', () => {
        const invalid = step(decision({ intent: 'shout' }));
        expect(policy.shouldStop(view([invalid, decided(), decided(), decided()]))).toBe(false);
    });

    it('does not add up decisions the agent made between reads', () => {
        expect(
            policy.shouldStop(view([decided(), decided(), read(), decided(), decided()])),
        ).toBe(false);
        expect(
            policy.shouldStop(
                view([decided(), read(), decided(), decided(), decided(), decided()]),
            ),
        ).toBe(true);
    });

    it('counts a step with a decision and a read as work', () => {
        const both = step(decision({ intent: 'answer' }), { name: 'readFile', input: {} });
        expect(policy.shouldStop(view([decided(), decided(), both, decided()]))).toBe(false);
    });

    // The refusal tells the agent to call kodusDecideAction again: a decision
    // after it must still count as a fresh chance.
    it('lets the agent decide again after a refused write', () => {
        const refused = step({ name: 'kodus_save_memory', input: {} });
        expect(
            policy.shouldStop(view([decided(), decided(), refused, decided(), decided(), decided()])),
        ).toBe(false);
    });

    it('answers "noted" twice, then tells the agent to carry it out or reply', async () => {
        const tool: any = buildDecisionTool()[CONVERSATION_DECISION_TOOL];
        const answers = [];
        for (let i = 0; i < 3; i++) {
            answers.push(await tool.execute({ intent: 'answer' }, {}));
        }
        expect(answers).toEqual(['noted', 'noted', DECISION_LIMIT_NOTE]);
        expect(DECISION_LIMIT_NOTE).toBe(
            'Decision noted. Do not call kodusDecideAction again this turn: carry out what you decided with the tool it names, or write your reply to the developer now.',
        );
    });

    it('does not count a malformed call toward the limit', async () => {
        const tool: any = buildDecisionTool()[CONVERSATION_DECISION_TOOL];
        await tool.execute({ intent: 'shout' }, {});
        await tool.execute({ intent: 'answer' }, {});
        expect(await tool.execute({ intent: 'answer' }, {})).toBe('noted');
    });

    // Kimi K2.7 left out `tool` on its first acts; the developer's request
    // must still go through on the act that names it.
    it('still authorizes an act recorded past the limit', async () => {
        const developer = 'please save this as a memory: use pnpm';
        const authorization = createWriteAuthorization();
        const tool: any = buildDecisionTool((d) =>
            grantIfAuthorized(d, developer, authorization),
        )[CONVERSATION_DECISION_TOOL];

        await tool.execute({ intent: 'act', authorizingQuote: 'please save this' }, {});
        await tool.execute({ intent: 'act', authorizingQuote: 'please save this' }, {});
        expect(authorization.allows('kodus_save_memory')).toBe(false);

        const answer = await tool.execute(
            { intent: 'act', tool: 'kodus_save_memory', authorizingQuote: 'please save this' },
            {},
        );

        expect(answer).toBe(DECISION_LIMIT_NOTE);
        expect(authorization.allows('kodus_save_memory')).toBe(true);
    });
});
