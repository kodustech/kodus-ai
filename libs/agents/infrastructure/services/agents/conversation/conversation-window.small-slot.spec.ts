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
import { conversationAnswerTokens } from './conversation-window';

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
