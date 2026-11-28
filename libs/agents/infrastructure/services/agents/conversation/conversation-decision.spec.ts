import {
    CONVERSATION_DECISION_TOOL,
    authorizedByDeveloper,
    buildDecisionTool,
    grantIfAuthorized,
    readDecision,
    readDecisions,
    writeCallsSinceLastRetraction,
} from './conversation-decision';
import { createWriteAuthorization } from './write-authorization';

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

    // gpt-luna named the tool with OpenAI's internal namespace, and the write
    // the developer asked for was never authorized.
    it("drops a leading 'functions.' from the tool the agent names", () => {
        expect(
            readDecision([
                call({ intent: 'act', tool: 'functions.kodus_save_memory' }),
            ])?.tool,
        ).toBe('kodus_save_memory');
        expect(
            readDecision([
                call({ intent: 'act', tool: 'kodus.functions.save' }),
            ])?.tool,
        ).toBe('kodus.functions.save');
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

    it('still accepts the plain confirmations a developer actually writes', () => {
        expect(
            authorizedByDeveloper('yes please', '@kody yes please, save it'),
        ).toBe(true);
        expect(authorizedByDeveloper('go ahead', '@kody go ahead')).toBe(true);
    });
});

describe('grantIfAuthorized', () => {
    const message = '@kody yes, please save that as a memory.';

    it('grants the tool the agent declared', () => {
        const auth = createWriteAuthorization();

        expect(
            grantIfAuthorized(
                {
                    intent: 'act',
                    tool: 'KODUS_CREATE_MEMORY',
                    authorizingQuote: 'save that as a memory',
                },
                message,
                auth,
            ),
        ).toBe(true);
        expect(auth.allows('KODUS_CREATE_MEMORY')).toBe(true);
    });

    it('refuses an act that names no tool, rather than granting them all', () => {
        const auth = createWriteAuthorization();

        expect(
            grantIfAuthorized(
                { intent: 'act', authorizingQuote: 'save that as a memory' },
                message,
                auth,
            ),
        ).toBe(false);
        expect(auth.allows('KODUS_DELETE_KODY_RULE')).toBe(false);
    });

    it('grants nothing for an offer', () => {
        const auth = createWriteAuthorization();

        grantIfAuthorized(
            { intent: 'offer', tool: 'KODUS_CREATE_MEMORY' },
            message,
            auth,
        );

        expect(auth.allows('KODUS_CREATE_MEMORY')).toBe(false);
    });
});

describe('buildDecisionTool', () => {
    it('is exposed under the name the runner collects as the result', () => {
        expect(Object.keys(buildDecisionTool())).toEqual([
            CONVERSATION_DECISION_TOOL,
        ]);
    });

    it('grants before it yields, which the write gate depends on', () => {
        const auth = createWriteAuthorization();
        const tools = buildDecisionTool((d) =>
            grantIfAuthorized(d, '@kody save that as a memory', auth),
        );

        // Deliberately NOT awaited. A write emitted alongside this call reads
        // the authorization one microtask later, so the grant has to land in
        // the synchronous part of execute. Put an `await` above onDecision and
        // this fails — which is the point.
        void tools[CONVERSATION_DECISION_TOOL].execute!(
            {
                intent: 'act',
                tool: 'KODUS_CREATE_MEMORY',
                authorizingQuote: 'save that as a memory',
            },
            {} as never,
        );

        expect(auth.allows('KODUS_CREATE_MEMORY')).toBe(true);
    });

    it('reports the decision as soon as it runs, not a step later', async () => {
        const seen: unknown[] = [];
        const tools = buildDecisionTool((d) => seen.push(d));

        await tools[CONVERSATION_DECISION_TOOL].execute!(
            {
                intent: 'act',
                tool: 'KODUS_CREATE_MEMORY',
                authorizingQuote: 'x',
            },
            {} as never,
        );

        // A model that emits the decision and the write in ONE message would
        // otherwise be refused: the policy only sees completed steps.
        expect(seen).toEqual([
            {
                intent: 'act',
                tool: 'KODUS_CREATE_MEMORY',
                authorizingQuote: 'x',
            },
        ]);
    });
});

describe('readDecisions', () => {
    it('keeps every decision of the run in order, skipping malformed calls', () => {
        expect(
            readDecisions([
                call({ intent: 'act', tool: 'KODUS_CREATE_MEMORY' }),
                call({ intent: 'nonsense' }),
                call({ intent: 'act', tool: 'exec' }),
            ]).map((d) => d.tool),
        ).toEqual(['KODUS_CREATE_MEMORY', 'exec']);
    });

    it('agrees with readDecision on the last one', () => {
        const steps = [
            call({ intent: 'offer', tool: 'KODUS_CREATE_MEMORY' }),
            call({ intent: 'answer' }),
        ];
        expect(readDecisions(steps).at(-1)).toEqual(readDecision(steps));
    });
});

describe('writeCallsSinceLastRetraction', () => {
    const isWrite = (name: string) => name === 'KODUS_CREATE_MEMORY';
    const tools = (...names: string[]) => ({
        index: 0,
        message: {
            role: 'assistant' as const,
            content: '',
            toolCalls: names.map((name, i) => ({
                id: `t${i}`,
                name,
                input: {},
            })),
        },
    });

    it('keeps every write call when every decision is act', () => {
        expect(
            writeCallsSinceLastRetraction(
                [
                    call({ intent: 'act', tool: 'exec' }),
                    tools('exec', 'KODUS_CREATE_MEMORY'),
                ],
                isWrite,
            ),
        ).toEqual(['KODUS_CREATE_MEMORY']);
    });

    // A refused write is told to offer instead; the agent did, then went on
    // to read. That write was withdrawn.
    it('drops write calls made before the last offer or answer', () => {
        expect(
            writeCallsSinceLastRetraction(
                [
                    tools('KODUS_CREATE_MEMORY'),
                    call({ intent: 'offer', tool: 'KODUS_CREATE_MEMORY' }),
                    call({ intent: 'act', tool: 'exec' }),
                    tools('exec'),
                ],
                isWrite,
            ),
        ).toEqual([]);
    });

    it('keeps a refused write made with no retraction after it', () => {
        expect(
            writeCallsSinceLastRetraction(
                [
                    tools('KODUS_CREATE_MEMORY'),
                    call({ intent: 'act', tool: 'exec' }),
                ],
                isWrite,
            ),
        ).toEqual(['KODUS_CREATE_MEMORY']);
    });
});
