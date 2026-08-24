// Mock ONLY generateText; keep jsonSchema / Output / the error classes real so
// the shared recovery toolkit (structured-output-repair) validates for real.
jest.mock('ai', () => {
    const actual = jest.requireActual('ai');
    return { ...actual, generateText: jest.fn() };
});

import {
    generateText,
    NoObjectGeneratedError,
    JSONParseError,
    TypeValidationError,
    NoSuchToolError,
} from 'ai';
import { repairInvalidToolInput } from './repair-tool-call';

const mockGenerate = generateText as unknown as jest.Mock;

// The tool's input schema — strict so a wrong-shape correction is rejected.
const TOOL_SCHEMA = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
};
const inputSchema = async () => TOOL_SCHEMA;

const toolCall = { toolName: 'read_file', input: { pat: 'typo' } };
const validationError = new TypeValidationError({
    value: { pat: 'typo' },
    cause: new Error('must have required property path'),
});

/** Faithful stand-in for what generateText+Output.object throws on failure. */
const noObjectError = (cause: Error, text: string) =>
    new NoObjectGeneratedError({
        message: 'No object generated (test)',
        cause,
        text,
        response: {} as any,
        usage: {} as any,
        finishReason: 'stop',
    });

beforeEach(() => mockGenerate.mockReset());

describe('repairInvalidToolInput — shared structured-output recovery', () => {
    it('returns null immediately for an unknown tool (no re-ask)', async () => {
        const out = await repairInvalidToolInput({
            model: {} as any,
            toolCall,
            inputSchema,
            error: new NoSuchToolError({ toolName: 'ghost' }),
        });
        expect(out).toBeNull();
        expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('accepts a conforming correction (stringified back into the tool call)', async () => {
        mockGenerate.mockResolvedValueOnce({
            experimental_output: { path: 'src/a.ts' },
        });
        const out = await repairInvalidToolInput({
            model: {} as any,
            toolCall,
            inputSchema,
            error: validationError,
        });
        expect(out).toEqual({
            ...toolCall,
            input: JSON.stringify({ path: 'src/a.ts' }),
        });
    });

    it('REJECTS a still-wrong correction (→ null, no longer blindly accepted)', async () => {
        // Output.object now validates and throws when the correction still fails
        // the schema. Before the shared validator this was accepted via a blind
        // JSON.stringify — the silent-mismatch bug (#1786) in the finder path.
        mockGenerate.mockRejectedValueOnce(
            noObjectError(
                new TypeValidationError({
                    value: { wrong: 1 },
                    cause: new Error('still wrong'),
                }),
                '{"wrong":1}',
            ),
        );
        const out = await repairInvalidToolInput({
            model: {} as any,
            toolCall,
            inputSchema,
            error: validationError,
        });
        expect(out).toBeNull();
    });

    it('recovers a fenced-but-valid correction via the deterministic tier', async () => {
        // The correction was valid JSON wrapped in a ```json fence → Output.object
        // failed to parse it, but the shared deterministic repair recovers it and
        // re-validates against the tool schema before accepting.
        mockGenerate.mockRejectedValueOnce(
            noObjectError(
                new JSONParseError({
                    text: '```json\n{"path":"src/b.ts"}\n```',
                    cause: new Error('Unexpected token `'),
                }),
                '```json\n{"path":"src/b.ts"}\n```',
            ),
        );
        const out = await repairInvalidToolInput({
            model: {} as any,
            toolCall,
            inputSchema,
            error: validationError,
        });
        expect(out).toEqual({
            ...toolCall,
            input: JSON.stringify({ path: 'src/b.ts' }),
        });
    });

    it('is fail-soft: a non-recoverable error resolves to null', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('model exploded'));
        const out = await repairInvalidToolInput({
            model: {} as any,
            toolCall,
            inputSchema,
            error: validationError,
        });
        expect(out).toBeNull();
    });
});
