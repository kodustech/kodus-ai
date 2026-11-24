import { estimateTextTokens } from '@libs/llm/token-estimate';

import { conversationCompression } from './conversation-window';

/**
 * What a chat step sends the model: the PR diff a tool read stays whole while
 * the request fits, and a dense result is measured at its real size.
 */

const slot = {
    provider: 'openai_compatible',
    model: 'local-open-weights',
    apiKey: '',
    maxInputTokens: 32_000,
    maxOutputTokens: 4_000,
} as any;

const withToolResult = (value: string) => [
    { role: 'user', content: '@kody what does this PR change in checkout?' },
    {
        role: 'assistant',
        content: [
            {
                type: 'tool-call',
                toolCallId: 'diff',
                toolName: 'KODUS_GET_PULL_REQUEST_DIFF',
                input: {},
            },
        ],
    },
    {
        role: 'tool',
        content: [
            {
                type: 'tool-result',
                toolCallId: 'diff',
                toolName: 'KODUS_GET_PULL_REQUEST_DIFF',
                output: { type: 'text', value },
            },
        ],
    },
];

async function send(messages: unknown[]) {
    const policy = await conversationCompression({
        slot,
        systemPrompt: 'You answer questions about pull requests.',
        tools: [],
        answerTokens: 20_000,
    });
    const directive = await policy.prepareStep?.({
        messages,
        stepNumber: 1,
    } as any);
    return (directive?.messages ?? messages) as any[];
}

describe('conversationCompression', () => {
    it('sends a PR diff that fits whole, past the usage threshold', async () => {
        const diff = Array.from(
            { length: 1_900 },
            (_, line) => `+export const checkout${line} = price(${line});`,
        ).join('\n');
        const messages = withToolResult(diff);
        const tokens = estimateTextTokens(JSON.stringify(messages));
        // Over 70% of the window, within what the 4k answer leaves.
        expect(tokens).toBeGreaterThan(32_000 * 0.7);
        expect(tokens + 4_000).toBeLessThan(32_000 * 0.92);

        const sent = await send(messages);

        expect(sent[2].content[0].output.value).toBe(diff);
    });

    it('measures a dense result at its worst and cuts it to the window (#2233)', async () => {
        let seed = 7;
        const bytes = Buffer.alloc(45_000);
        for (let i = 0; i < bytes.length; i++) {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            bytes[i] = seed % 256;
        }
        const image = `+![logo](data:image/png;base64,${bytes.toString('base64')})`;
        const messages = withToolResult(image);
        const worst = (value: unknown) =>
            estimateTextTokens(JSON.stringify(value), { worstCase: true });
        // The ordinary count reads it as fitting; it does not.
        expect(estimateTextTokens(JSON.stringify(messages))).toBeLessThan(
            32_000 * 0.7,
        );
        expect(worst(messages)).toBeGreaterThan(32_000);

        const sent = await send(messages);

        expect(worst(sent) + 4_000).toBeLessThanOrEqual(32_000);
    });
});
