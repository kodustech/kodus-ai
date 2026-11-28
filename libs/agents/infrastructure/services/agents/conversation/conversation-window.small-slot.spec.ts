/**
 * QA of #2681 (#2233): on a 24k slot with no maxOutputTokens, the chat
 * reserved a 20k answer, which left 4k for a prompt whose 29 tool schemas
 * alone took 7.5k, and the final trim cut the developer's question. The
 * answer a conversation reserves is now at most a quarter of the smallest
 * window it may run on, and the tool list is counted with its schemas.
 */
import { jsonSchema, tool } from 'ai';
import { z } from 'zod';

import { estimateOverheadTokens } from '@libs/agent-harness/infrastructure/compression/token-estimator';
import { AiSdkToolRegistry } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-tool-registry';
import {
    clampMessagesToBudget,
    estimateMessagesTokens,
    type ModelMessage,
} from '@libs/agent-harness/infrastructure/compression/context-compressor';
import {
    conversationAnswerTokens,
    conversationMessageBudget,
} from './conversation-window';
import {
    buildSystemPrompt,
    buildUserPrompt,
    fitUserPrompt,
} from './conversation-prompt';

const slot = (maxInputTokens: number, fallback?: object) =>
    ({
        provider: 'openai_compatible',
        model: 'deepseek-v4.1-flash',
        maxInputTokens,
        ...(fallback ? { fallback } : {}),
    }) as never;

describe('the answer a conversation reserves', () => {
    it('is a quarter of a small window, not 20k of 24k', () => {
        expect(conversationAnswerTokens(slot(24_000))).toBe(6_000);
    });

    it('never reserves less than 1,024 tokens', () => {
        expect(conversationAnswerTokens(slot(3_000))).toBe(1_024);
    });

    it('keeps 20k where the window has room for it', () => {
        expect(conversationAnswerTokens(slot(200_000))).toBe(20_000);
    });

    it('follows the smaller window when the fallback is the smaller one', () => {
        expect(
            conversationAnswerTokens(
                slot(1_000_000, {
                    provider: 'openai_compatible',
                    model: 'glm-x',
                    maxInputTokens: 16_000,
                }),
            ),
        ).toBe(4_000);
    });
});

describe('the tool list a request carries', () => {
    const tools = {
        readFile: tool({
            description: 'Read a file',
            inputSchema: z.object({
                path: z.string().describe('Repository-relative file path'),
                startLine: z.number().optional(),
                endLine: z.number().optional(),
            }),
            execute: async () => '',
        }),
        kodus_search: tool({
            description: 'Search memories',
            inputSchema: jsonSchema({
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to look for' },
                    repository: { type: 'string' },
                },
            }),
            execute: async () => '',
        }),
    };

    it('is counted with each input schema, which the provider is sent', () => {
        const registry = new AiSdkToolRegistry(tools);
        const withSchemas = estimateOverheadTokens('', registry.definitions());
        const views = estimateOverheadTokens('', registry.list());
        expect(withSchemas).toBeGreaterThan(views);
        const sent = JSON.stringify(
            registry.definitions().map((d) => d.inputSchema),
        );
        expect(sent).toContain('Repository-relative file path');
        expect(sent).toContain('What to look for');
    });
});

// Review of #2793, round 2: on a 16k slot a developer asks "why does this
// fail?" and pastes a stack trace below it. Cut from the middle by the
// last-resort clamp, the prompt kept the PR description and the end of the
// trace and dropped the question between them.
describe("the developer's message on a small slot", () => {
    const question =
        'Why does applySiblingDiscount fail for the second sibling?';
    const trace = Array.from(
        { length: 60 },
        (_, i) =>
            `    at EnrollmentFeeService.calculate (src/enrollment/fee.service.ts:${i + 10}:17)`,
    ).join('\n');
    const message = `${question}\n\n\`\`\`\n${trace}\n\`\`\``;
    const userPrompt = buildUserPrompt({
        prompt: message,
        userLanguage: 'en-US',
        prepareContext: {
            pullRequest: {
                pullRequestNumber: 37,
                headRef: 'feat',
                baseRef: 'main',
            },
            repository: { id: 'r1', name: 'school' },
            pullRequestDescription: `## Summary\n${'The enrollment fee now applies a sibling discount and rounds to two decimals. '.repeat(400)}`,
        } as never,
        organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
        availableTools: [],
        hasSandbox: true,
    });
    /** About the 7.5k tokens of the 29 tool schemas the QA proxy recorded. */
    const toolSchemas = Array.from({ length: 28 }, (_, i) => ({
        name: `tool_${i}`,
        description:
            'Reads one thing from the repository or the platform. '.repeat(24),
        inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
        },
    }));
    const budgetFor = (maxInputTokens: number) =>
        conversationMessageBudget({
            slot: slot(maxInputTokens),
            systemPrompt: buildSystemPrompt('en-US'),
            tools: toolSchemas,
            answerTokens: conversationAnswerTokens(slot(maxInputTokens)),
        });
    const sent = async (maxInputTokens: number, later: ModelMessage[] = []) => {
        const budget = await budgetFor(maxInputTokens);
        const first = fitUserPrompt(userPrompt, Math.floor(budget * 0.75));
        const clamped = clampMessagesToBudget(
            [{ role: 'user', content: first }, ...later],
            budget,
        );
        return { budget, clamped, text: String(clamped[0].content) };
    };

    it.each([12_000, 14_000, 16_000, 18_000, 24_000])(
        'keeps the question within the budget on a %i slot',
        async (window) => {
            const { budget, clamped, text } = await sent(window);
            expect(budget).toBeGreaterThan(0);
            expect(estimateMessagesTokens(clamped)).toBeLessThanOrEqual(budget);
            expect(text).toContain(question);
        },
    );

    it.each([18_000, 24_000])(
        'keeps the whole trace too where it fits, on a %i slot',
        async (window) => {
            expect((await sent(window)).text).toContain(message);
        },
    );

    it('keeps the question after a step that read a large diff', async () => {
        const diffRead: ModelMessage[] = [
            {
                role: 'assistant',
                content: [
                    {
                        type: 'tool-call',
                        toolCallId: 'd1',
                        toolName: 'KODUS_GET_PULL_REQUEST_DIFF',
                        input: { prNumber: 37 },
                    },
                ],
            },
            {
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: 'd1',
                        toolName: 'KODUS_GET_PULL_REQUEST_DIFF',
                        output: {
                            type: 'text',
                            value: `+${'const fee = base;\n+'.repeat(6_000)}`,
                        },
                    },
                ],
            },
        ];
        const { budget, clamped, text } = await sent(16_000, diffRead);
        expect(estimateMessagesTokens(clamped)).toBeLessThanOrEqual(budget);
        expect(text).toContain(question);
    });

    it.each([12_000, 14_000])(
        'is what the last-resort clamp alone dropped on a %i slot',
        async (window) => {
            const budget = await budgetFor(window);
            const text = String(
                clampMessagesToBudget(
                    [{ role: 'user', content: userPrompt }],
                    budget,
                )[0].content,
            );
            expect(text).not.toContain(question);
        },
    );

    it('cuts the context, never the message, and leaves a short prompt alone', () => {
        const short = buildUserPrompt({
            prompt: question,
            userLanguage: 'en-US',
            organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
            availableTools: [],
            hasSandbox: false,
        });
        expect(fitUserPrompt(short, 100_000)).toBe(short);
        const fitted = fitUserPrompt(userPrompt, 2_500);
        expect(fitted.endsWith(`USER MESSAGE:\n${message}`)).toBe(true);
        expect(fitted).toContain('…[truncated]…');
        expect(fitted.length).toBeLessThan(userPrompt.length);
    });

    it('cuts a message larger than the room from its middle, beside a quarter of context', () => {
        const fitted = fitUserPrompt(userPrompt, 600);
        const [head, kept] = fitted.split('\nUSER MESSAGE:\n');
        expect(kept.startsWith(question)).toBe(true);
        expect(kept.endsWith('```')).toBe(true);
        expect(kept).toContain('…[truncated]…');
        expect(head.startsWith('## Conversation context')).toBe(true);
    });

    it('sends the prompt as it is when no cut can fit it', () => {
        expect(fitUserPrompt(userPrompt, 0)).toBe(userPrompt);
    });
});
