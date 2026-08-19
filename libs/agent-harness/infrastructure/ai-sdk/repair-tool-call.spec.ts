/**
 * Unit tests for the tool-call self-heal policy (repairToolCall seam).
 * Mocks only `generateText`; NoSuchToolError stays the real AI SDK class.
 */
jest.mock('ai', () => {
    const actual = jest.requireActual('ai');
    return { ...actual, generateText: jest.fn() };
});

import { generateText, NoSuchToolError } from 'ai';
import { repairInvalidToolInput } from '@libs/llm/repair-tool-call';

const mockGenerateText = generateText as jest.MockedFunction<
    typeof generateText
>;

const model = { __model: true } as any;
const inputSchema = async () => ({ type: 'object' as const });

describe('repairInvalidToolInput — tool-call self-heal', () => {
    beforeEach(() => mockGenerateText.mockReset());

    it('does NOT repair a wrong tool name (NoSuchToolError) — passes through as null', async () => {
        const err = new NoSuchToolError({
            toolName: 'ghost',
            availableTools: ['real'],
        });

        const out = await repairInvalidToolInput({
            model,
            toolCall: { toolName: 'ghost', input: '{}' },
            inputSchema,
            error: err,
        });

        expect(out).toBeNull();
        expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it('re-generates arguments against the schema on an input-validation error', async () => {
        mockGenerateText.mockResolvedValue({
            experimental_output: { path: 'a.ts', line: 3 },
        } as any);

        const out = await repairInvalidToolInput({
            model,
            toolCall: { toolCallId: 'c1', toolName: 'flag', input: '{bad json' },
            inputSchema,
            error: new Error('input did not match schema'),
        });

        expect(mockGenerateText).toHaveBeenCalledTimes(1);
        // same model reused (correct BYOK attribution), schema wired in.
        expect(mockGenerateText.mock.calls[0][0].model).toBe(model);
        // returns the original call with repaired, re-serialized input.
        expect(out).toEqual({
            toolCallId: 'c1',
            toolName: 'flag',
            input: JSON.stringify({ path: 'a.ts', line: 3 }),
        });
    });

    it('is fail-soft — a failing repair resolves to null (current behavior)', async () => {
        mockGenerateText.mockRejectedValue(new Error('repair model down'));

        const out = await repairInvalidToolInput({
            model,
            toolCall: { toolName: 'flag', input: '{}' },
            inputSchema,
            error: new Error('input did not match schema'),
        });

        expect(out).toBeNull();
    });
});
