/**
 * Repro for issue #1761 — `@kody` answers PR threads but never offers to act on
 * what they reveal.
 *
 * Runs the real `ConversationAgentProvider` over the thread fixtures with a
 * mocked model + MCP adapter, then inspects what the agent actually hands the
 * model: the system prompt, the user prompt and the bound tool set. No LLM, so
 * the result is deterministic and the failures point at a concrete omission
 * rather than at model behavior.
 *
 * The `it.failing` blocks below are the bug. They pass while the gap exists and
 * start failing ("Failing test passed") the moment it is closed — at which
 * point flip them to `it` and they become the regression guard.
 */
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: () => ({
        model: scriptedModel.current,
        callOptions: {},
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    }),
}));

jest.mock('@libs/mcp-server/mcp-adapter', () => ({
    createMCPAdapter: () => ({
        connect: async () => undefined,
        disconnect: async () => undefined,
        getTools: async () =>
            ORG_MCP_TOOLS.map((name) => ({
                name,
                description: `${name} (stub)`,
                inputSchema: { type: 'object', properties: {} },
            })),
        executeTool: async (name: string, args: Record<string, unknown>) => {
            executedTools.push({ name, args });
            return { success: true };
        },
    }),
}));

import { MockLanguageModelV3 } from 'ai/test';

import { ConversationAgentProvider } from '@libs/agents/infrastructure/services/agents/conversationAgent';

import {
    CONFIRMATION_TURN,
    ORGANIZATION_AND_TEAM_DATA,
    THREAD_GIT_USER,
    THREAD_SCENARIOS,
    type ThreadScenario,
} from './__test-utils__/kody-thread-scenarios';

/** Tools the auto-registered Kodus MCP exposes to every org. */
const ORG_MCP_TOOLS = [
    'KODUS_FIND_MEMORIES',
    'KODUS_CREATE_MEMORY',
    'KODUS_GET_KODY_RULES',
    'KODUS_CREATE_KODY_RULE',
    'KODUS_UPDATE_KODY_RULE',
    'KODUS_DELETE_KODY_RULE',
    'KODUS_CREATE_KODY_ISSUE',
    'KODUS_LIST_KODY_ISSUES',
    'KODUS_UPDATE_KODY_ISSUE_STATUS',
    'KODUS_UPDATE_KODY_ISSUE_CATEGORY',
];

const WRITE_TOOLS = ORG_MCP_TOOLS.filter(
    (name) =>
        !name.startsWith('KODUS_GET_') &&
        !name.startsWith('KODUS_LIST_') &&
        name !== 'KODUS_FIND_MEMORIES',
);

const scriptedModel: { current: MockLanguageModelV3 | null } = {
    current: null,
};
let executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];

interface CapturedTurn {
    systemPrompt: string;
    userPrompt: string;
    /** Every message the model saw, flattened — catches replayed history. */
    conversation: string;
    toolNames: string[];
}

const captured: CapturedTurn[] = [];

function textOf(content: unknown): string {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part: any) =>
                typeof part?.text === 'string'
                    ? part.text
                    : JSON.stringify(part),
            )
            .join('\n');
    }
    return '';
}

/**
 * A model that records what it was given and answers with `replies` in order.
 * A reply may be a tool call, so a turn can be driven all the way through the
 * MCP execute path.
 */
function recordingModel(
    replies: Array<
        string | { toolName: string; input: Record<string, unknown> }
    >,
): MockLanguageModelV3 {
    let call = 0;
    return new MockLanguageModelV3({
        doGenerate: async (options: any) => {
            const messages = options.prompt ?? [];
            captured.push({
                systemPrompt: textOf(
                    messages.find((m: any) => m.role === 'system')?.content,
                ),
                userPrompt: textOf(
                    messages.find((m: any) => m.role === 'user')?.content,
                ),
                conversation: messages
                    .map((m: any) => `[${m.role}] ${textOf(m.content)}`)
                    .join('\n'),
                toolNames: (options.tools ?? []).map((t: any) => t.name),
            });

            const reply = replies[Math.min(call++, replies.length - 1)];
            const isToolCall = typeof reply !== 'string';

            return {
                content: isToolCall
                    ? [
                          {
                              type: 'tool-call',
                              toolCallId: `call-${call}`,
                              toolName: reply.toolName,
                              input: JSON.stringify(reply.input),
                          },
                      ]
                    : [{ type: 'text', text: reply }],
                finishReason: isToolCall
                    ? { unified: 'tool-calls', raw: 'tool_calls' }
                    : { unified: 'stop', raw: 'stop' },
                usage: {
                    inputTokens: {
                        total: 10,
                        noCache: 10,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                    outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
                warnings: [],
            } as any;
        },
    });
}

function buildProvider(conversationStore?: {
    load: jest.Mock;
    append: jest.Mock;
}) {
    return new ConversationAgentProvider(
        {
            findByKey: jest.fn().mockResolvedValue({ configValue: 'en-US' }),
        } as any,
        { resolveTaskSlot: jest.fn().mockResolvedValue(null) } as any,
        {
            getConnections: jest
                .fn()
                .mockResolvedValue([{ name: 'kodus-mcp', type: 'http' }]),
        } as any,
        undefined,
        conversationStore as any,
    );
}

async function runTurn(
    scenario: ThreadScenario,
    opts: {
        replies?: Array<
            string | { toolName: string; input: Record<string, unknown> }
        >;
        conversationStore?: { load: jest.Mock; append: jest.Mock };
    } = {},
): Promise<CapturedTurn> {
    captured.length = 0;
    scriptedModel.current = recordingModel(
        opts.replies ?? ['Agreed — that finding does not apply here.'],
    );

    await buildProvider(opts.conversationStore).execute(scenario.userMessage, {
        organizationAndTeamData: ORGANIZATION_AND_TEAM_DATA,
        thread: {
            id: `TR-cmc-${scenario.id}`,
            metadata: { channel: 'github' },
        },
        prepareContext: scenario.prepareContext,
    } as any);

    return captured[0];
}

const scenarioById = (id: string) => THREAD_SCENARIOS.find((s) => s.id === id)!;

const actionableScenarios = THREAD_SCENARIOS.filter((s) => s.expectedOffer);

beforeEach(() => {
    executedTools = [];
});

describe('@kody proactive actions in PR threads (issue #1761)', () => {
    describe('the machinery is already in place', () => {
        it('binds every org write tool into the conversation tool registry', async () => {
            const turn = await runTurn(
                scenarioById('false-positive-on-kody-rule'),
            );

            expect(turn.toolNames).toEqual(expect.arrayContaining(WRITE_TOOLS));
        });

        it('executes a write tool end to end when the model does call it', async () => {
            await runTurn(scenarioById('false-positive-on-kody-rule'), {
                replies: [
                    {
                        toolName: 'KODUS_CREATE_MEMORY',
                        input: {
                            organizationId:
                                ORGANIZATION_AND_TEAM_DATA.organizationId,
                            teamId: ORGANIZATION_AND_TEAM_DATA.teamId,
                            kodyRule: {
                                title: 'Retry wrapper handles transient errors',
                                rule: 'Do not require an extra try/catch around calls already wrapped in retry().',
                            },
                        },
                    },
                    'Recorded.',
                ],
            });

            expect(executedTools.map((t) => t.name)).toEqual([
                'KODUS_CREATE_MEMORY',
            ]);
        });
    });

    describe('but the agent is never told to use it', () => {
        it.failing.each(actionableScenarios)(
            'offers $expectedOffer when the thread reveals: $signal',
            async (scenario) => {
                const turn = await runTurn(scenario);

                expect(turn.toolNames).toContain(scenario.expectedOffer);
                expect(`${turn.systemPrompt}\n${turn.userPrompt}`).toContain(
                    scenario.expectedOffer,
                );
            },
        );

        it.failing(
            'instructs the agent to evaluate whether the exchange is worth persisting',
            async () => {
                const turn = await runTurn(
                    scenarioById('false-positive-on-kody-rule'),
                );
                const prompt =
                    `${turn.systemPrompt}\n${turn.userPrompt}`.toLowerCase();

                expect(prompt).toMatch(/offer|propose|persist|record/);
            },
        );

        it.failing(
            'carries the identifiers a write tool needs to be callable',
            async () => {
                const turn = await runTurn(
                    scenarioById('real-but-out-of-scope'),
                );

                // KODUS_CREATE_KODY_ISSUE requires all of these.
                expect(turn.userPrompt).toContain('GITHUB');
                expect(turn.userPrompt).toContain('5150');
                expect(turn.userPrompt).toContain(THREAD_GIT_USER.username);
            },
        );

        it.failing(
            'replays its own prior offer so a confirmation can resolve it',
            async () => {
                const scenario = scenarioById(CONFIRMATION_TURN.scenarioId);
                const conversationStore = {
                    load: jest.fn().mockResolvedValue([
                        { role: 'user', content: scenario.userMessage },
                        {
                            role: 'assistant',
                            content: CONFIRMATION_TURN.priorOffer,
                        },
                    ]),
                    append: jest.fn().mockResolvedValue(undefined),
                };

                const turn = await runTurn(
                    { ...scenario, userMessage: CONFIRMATION_TURN.userMessage },
                    { conversationStore },
                );

                expect(conversationStore.load).toHaveBeenCalled();
                expect(turn.conversation).toContain(
                    CONFIRMATION_TURN.priorOffer,
                );
            },
        );
    });

    it('stays quiet when the thread reveals nothing worth persisting', async () => {
        const turn = await runTurn(scenarioById('no-durable-signal'));

        expect(executedTools).toHaveLength(0);
        expect(turn.userPrompt).toContain('@kody what does this diff do?');
    });
});
