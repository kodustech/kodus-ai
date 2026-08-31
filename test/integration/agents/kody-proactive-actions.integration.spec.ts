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
 * Written first as a red repro (`it.failing`), then flipped block by block as
 * each gap closed. It now guards the behavior: every scenario the issue lists
 * must keep reaching the model with the matching action named.
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
            ORG_MCP_TOOLS.map((tool) => ({
                name: tool.name,
                description: tool.description,
                annotations: tool.annotations,
                inputSchema: { type: 'object', properties: {} },
            })),
        executeTool: async (name: string, args: Record<string, unknown>) => {
            executedTools.push({ name, args });
            return {
                success: true,
                data: {
                    link: 'https://app.kodus.io/settings/code-review/7/kody-rules/real-abc?tab=memories',
                },
            };
        },
    }),
}));

import { MockLanguageModelV3 } from 'ai/test';

import { ConversationAgentProvider } from '@libs/agents/infrastructure/services/agents/conversationAgent';
import { KodyIssuesTools } from '@libs/mcp-server/tools/kodyIssues.tools';
import { KodyRulesTools } from '@libs/mcp-server/tools/kodyRules.tools';

import {
    CONFIRMATION_TURN,
    ORGANIZATION_AND_TEAM_DATA,
    THREAD_GIT_USER,
    THREAD_SCENARIOS,
    type ThreadScenario,
} from './__test-utils__/kody-thread-scenarios';

/**
 * The REAL Kodus MCP tool definitions — names, descriptions and annotations as
 * the server serves them. Using the real declarations rather than a hand-kept
 * copy is what proves the agent derives its behavior from them: re-annotate a
 * tool at the source and these expectations move with it.
 */
const ORG_MCP_TOOLS = [
    ...new KodyRulesTools({} as never, {} as never, {} as never).getAllTools(),
    ...new KodyIssuesTools({} as never, {} as never).getAllTools(),
];

const WRITE_TOOLS = ORG_MCP_TOOLS.filter(
    (t) => t.annotations?.readOnlyHint === false,
).map((t) => t.name);

const scriptedModel: { current: MockLanguageModelV3 | null } = {
    current: null,
};
let executedTools: Array<{ name: string; args: Record<string, unknown> }> = [];
let logged: Array<Record<string, unknown>> = [];

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
    const provider = new ConversationAgentProvider(
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

    const logger = (provider as any).logger;
    const log = logger.log.bind(logger);
    logger.log = (payload: any) => {
        logged.push(payload);
        return log(payload);
    };

    return provider;
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

/** Runs a turn and returns the text the developer would actually read. */
async function runTurnAnswer(
    scenario: ThreadScenario,
    replies: Array<
        string | { toolName: string; input: Record<string, unknown> }
    >,
): Promise<string> {
    captured.length = 0;
    scriptedModel.current = recordingModel(replies);

    return buildProvider().execute(scenario.userMessage, {
        organizationAndTeamData: ORGANIZATION_AND_TEAM_DATA,
        thread: {
            id: `TR-cmc-${scenario.id}`,
            metadata: { channel: 'github' },
        },
        prepareContext: scenario.prepareContext,
    } as never);
}

const scenarioById = (id: string) => THREAD_SCENARIOS.find((s) => s.id === id)!;

const actionableScenarios = THREAD_SCENARIOS.filter((s) => s.expectedOffer);

beforeEach(() => {
    executedTools = [];
    logged = [];
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

        it('never writes silently — the call is auditable', async () => {
            await runTurn(scenarioById('false-positive-on-kody-rule'), {
                replies: [
                    {
                        toolName: 'KODUS_CREATE_MEMORY',
                        input: { organizationId: 'org-11111111' },
                    },
                    'Recorded.',
                ],
            });

            const audit = logged.find(
                (entry: any) => entry?.metadata?.tool === 'KODUS_CREATE_MEMORY',
            );

            expect(audit).toBeDefined();
            expect((audit as any).metadata.threadId).toBe(
                'TR-cmc-false-positive-on-kody-rule',
            );
            expect((audit as any).metadata.developer).toBe(
                THREAD_GIT_USER.username,
            );
        });
    });

    describe('and the agent is told to use it', () => {
        it.each(actionableScenarios)(
            'offers $expectedOffer when the thread reveals: $signal',
            async (scenario) => {
                const turn = await runTurn(scenario);

                expect(turn.toolNames).toContain(scenario.expectedOffer);
                expect(`${turn.systemPrompt}\n${turn.userPrompt}`).toContain(
                    scenario.expectedOffer,
                );
            },
        );

        it('instructs the agent to evaluate whether the exchange is worth persisting', async () => {
            const turn = await runTurn(
                scenarioById('false-positive-on-kody-rule'),
            );
            const prompt =
                `${turn.systemPrompt}\n${turn.userPrompt}`.toLowerCase();

            expect(prompt).toMatch(/offer|propose|persist|record/);
        });

        it('carries the identifiers a write tool needs to be callable', async () => {
            const turn = await runTurn(scenarioById('real-but-out-of-scope'));

            // KODUS_CREATE_KODY_ISSUE requires all of these.
            expect(turn.userPrompt).toContain('GITHUB');
            expect(turn.userPrompt).toContain('5150');
            expect(turn.userPrompt).toContain(THREAD_GIT_USER.username);
        });

        it('replays its own prior offer so a confirmation can resolve it', async () => {
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
            expect(turn.conversation).toContain(CONFIRMATION_TURN.priorOffer);
        });
    });

    describe('the reply cannot claim more than the tools did', () => {
        it('strips a link the model invented on a turn that wrote nothing', async () => {
            const answer = await runTurnAnswer(
                scenarioById('false-positive-on-kody-rule'),
                [
                    'Done — saved it: https://app.kodus.io/settings/code-review/7/kody-rules/fake-999?tab=memories',
                ],
            );

            expect(executedTools).toHaveLength(0);
            expect(answer).not.toContain('fake-999');
            expect(answer).not.toContain('---');
            expect(answer).not.toContain('KODUS_');
        });

        it('publishes the link the tool really returned', async () => {
            const answer = await runTurnAnswer(
                scenarioById('false-positive-on-kody-rule'),
                [
                    {
                        toolName: 'KODUS_CREATE_MEMORY',
                        input: { organizationId: 'org-11111111' },
                    },
                    'Recorded it: https://app.kodus.io/settings/code-review/7/kody-rules/invented-000?tab=memories',
                ],
            );

            expect(answer).not.toContain('invented-000');
            expect(answer).toContain('kody-rules/real-abc');
            // The developer reads a reply, not a tool report.
            expect(answer).not.toContain('KODUS_');
            expect(answer).not.toContain('---');
        });

        it('tells the model mid-run that it has performed nothing', async () => {
            const turn = await runTurn(
                scenarioById('false-positive-on-kody-rule'),
            );

            expect(turn.conversation).toMatch(
                /ACTIONS PERFORMED THIS TURN: none/,
            );
        });
    });

    it('does not count a repo read as an action the agent performed', async () => {
        const sandbox = {
            type: 'e2b',
            remoteCommands: {
                grep: jest.fn().mockResolvedValue(''),
                read: jest.fn().mockResolvedValue(''),
                listDir: jest.fn().mockResolvedValue(''),
            },
        };

        captured.length = 0;
        scriptedModel.current = recordingModel([
            { toolName: 'grep', input: { pattern: 'retry' } },
            'Looked at the file.',
        ]);
        await buildProvider().execute('@kody what does this do?', {
            organizationAndTeamData: ORGANIZATION_AND_TEAM_DATA,
            thread: { id: 'TR-cmc-sandbox' },
            prepareContext: scenarioById('no-durable-signal').prepareContext,
            sandbox,
        } as never);

        expect(sandbox.remoteCommands.grep).toHaveBeenCalled();

        // The step after the grep still has to read as "nothing performed":
        // treating a read as an action is what lets the agent claim it acted.
        const note = captured
            .at(-1)!
            .conversation.match(/ACTIONS PERFORMED THIS TURN:[^\n]*/)?.[0];
        expect(note).toBeDefined();
        expect(note).toContain('none');
        expect(note).not.toContain('grep');
        expect(
            logged.filter((e: any) => e?.metadata?.tool === 'grep'),
        ).toHaveLength(0);
    });

    it('stays quiet when the thread reveals nothing worth persisting', async () => {
        const turn = await runTurn(scenarioById('no-durable-signal'));

        expect(executedTools).toHaveLength(0);
        expect(turn.userPrompt).toContain('@kody what does this diff do?');
    });
});
