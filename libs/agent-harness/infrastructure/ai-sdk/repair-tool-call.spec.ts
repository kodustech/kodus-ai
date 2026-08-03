/**
 * Unit tests for the tool-call self-heal policy (repairToolCall seam).
 * Mocks only `generateObject`; NoSuchToolError stays the real AI SDK class.
 */
jest.mock('ai', () => {
    const actual = jest.requireActual('ai');
    return { ...actual, generateObject: jest.fn() };
});

import { generateObject, NoSuchToolError } from 'ai';
import { repairInvalidToolInput } from './ai-sdk-agent-runner';

const mockGenerateObject = generateObject as jest.MockedFunction<
    typeof generateObject
>;

const model = { __model: true } as any;
const inputSchema = async () => ({ type: 'object' as const });

describe('repairInvalidToolInput — tool-call self-heal', () => {
    beforeEach(() => mockGenerateObject.mockReset());

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
        expect(mockGenerateObject).not.toHaveBeenCalled();
    });

    it('re-generates arguments against the schema on an input-validation error', async () => {
        mockGenerateObject.mockResolvedValue({
            object: { path: 'a.ts', line: 3 },
        } as any);

        const out = await repairInvalidToolInput({
            model,
            toolCall: { toolCallId: 'c1', toolName: 'flag', input: '{bad json' },
            inputSchema,
            error: new Error('input did not match schema'),
        });

        expect(mockGenerateObject).toHaveBeenCalledTimes(1);
        // same model reused (correct BYOK attribution), schema wired in.
        expect(mockGenerateObject.mock.calls[0][0].model).toBe(model);
        // returns the original call with repaired, re-serialized input.
        expect(out).toEqual({
            toolCallId: 'c1',
            toolName: 'flag',
            input: JSON.stringify({ path: 'a.ts', line: 3 }),
        });
    });

    it('is fail-soft — a failing repair resolves to null (current behavior)', async () => {
        mockGenerateObject.mockRejectedValue(new Error('repair model down'));

        const out = await repairInvalidToolInput({
            model,
            toolCall: { toolName: 'flag', input: '{}' },
            inputSchema,
            error: new Error('input did not match schema'),
        });

        expect(out).toBeNull();
    });
});
