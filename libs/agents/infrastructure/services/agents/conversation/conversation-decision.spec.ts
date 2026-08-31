import {
    CONVERSATION_DECISION_TOOL,
    authorizedByDeveloper,
    buildDecisionTool,
    readDecision,
} from './conversation-decision';

const call = (input: unknown) => ({
    index: 0,
    message: {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'c1', name: CONVERSATION_DECISION_TOOL, input }],
    },
});

describe('readDecision', () => {
    it('reads the decision the agent committed to', () => {
        const decision = readDecision([
            call({ intent: 'act', tool: 'KODUS_CREATE_MEMORY', why: 'asked' }),
        ]);

        expect(decision?.intent).toBe('act');
        expect(decision?.tool).toBe('KODUS_CREATE_MEMORY');
    });

    it('accepts the input as a JSON string, as providers send it', () => {
        expect(
            readDecision([call(JSON.stringify({ intent: 'offer' }))])?.intent,
        ).toBe('offer');
    });

    it('is undefined when the agent never decided', () => {
        expect(readDecision([])).toBeUndefined();
    });

    it('takes the last decision when the agent revised it', () => {
        const decision = readDecision([
            call({ intent: 'offer' }),
            {
                ...call({ intent: 'act', tool: 'X', why: 'confirmed' }),
                index: 1,
            },
        ]);

        expect(decision?.intent).toBe('act');
    });

    it('ignores a decision with an unknown intent', () => {
        expect(readDecision([call({ intent: 'whatever' })])).toBeUndefined();
    });
});

describe('authorizedByDeveloper', () => {
    const message = '@kody yes, please save that as a memory.';

    it('accepts a quote taken from the message', () => {
        expect(authorizedByDeveloper('save that as a memory', message)).toBe(
            true,
        );
    });

    it('ignores case and surrounding whitespace', () => {
        expect(authorizedByDeveloper('  SAVE THAT  ', message)).toBe(true);
    });

    it('rejects words the developer never wrote', () => {
        expect(authorizedByDeveloper('go ahead and delete it', message)).toBe(
            false,
        );
    });

    it('rejects an empty quote rather than waving it through', () => {
        expect(authorizedByDeveloper('', message)).toBe(false);
        expect(authorizedByDeveloper(undefined, message)).toBe(false);
    });
});

describe('buildDecisionTool', () => {
    it('is exposed under the name the runner collects as the result', () => {
        expect(Object.keys(buildDecisionTool())).toEqual([
            CONVERSATION_DECISION_TOOL,
        ]);
    });
});
