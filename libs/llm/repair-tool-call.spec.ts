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

    it("runs the re-ask inside the caller's usage span", async () => {
        const result = { experimental_output: { path: 'src/a.ts' } };
        mockGenerate.mockResolvedValueOnce(result);
        const inSpan = jest.fn((exec: () => Promise<unknown>) => exec());
        await repairInvalidToolInput({
            model: {} as any,
            toolCall,
            inputSchema,
            error: validationError,
            inSpan: inSpan as any,
        });
        expect(inSpan).toHaveBeenCalledTimes(1);
        await expect(inSpan.mock.results[0].value).resolves.toBe(result);
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

/* =====================================================================
 * I/O CONTRACT for the repairToolCall boundary (one case per branch; the
 * text extraction itself is specced in structured-output-repair.spec.ts).
 *
 * Declared output `D` = the SDK repair return: `{ ...toolCall, input:string }`
 * (a JSON-stringified corrected-args object) OR `null` (the SDK default
 * "don't repair, let the step fail"). "Inner" = the corrected-args object.
 *
 * Two layers carry model output into this boundary:
 *   L1 SUCCESS path — `generateText` resolves; `readOutput()` extracts
 *       `experimental_output ?? output`, then it is JSON.stringify'd verbatim.
 *   L2 SALVAGE path — `generateText` rejects with NoObjectGeneratedError;
 *       `salvageStructuredError` deterministically repairs the raw text and
 *       RE-VALIDATES it against the SAME tool schema before accepting.
 *
 * The #1786 non-degradation rule: for any off-schema row the boundary must
 * RECOVER the real payload OR SIGNAL explicitly (→ null). It must never
 * silently ship a wrong-shaped correction. Rows where prod still degrades
 * silently are pinned as `it.failing` (green now, red on the fix).
 *
 * `generateText` is the only mock; jsonSchema/Output/error classes + the whole
 * `structured-output-repair` toolkit run FOR REAL, so the salvage tier really
 * validates against the tool schema.
 * ===================================================================== */

/** JSONParseError-caused failure (the salvage-eligible transport error). */
const parseFail = (text: string) =>
    noObjectError(new JSONParseError({ text, cause: new Error('parse') }), text);

const call = (over: Record<string, unknown> = {}) =>
    repairInvalidToolInput({
        model: {} as any,
        toolCall,
        inputSchema,
        error: validationError,
        ...over,
    } as any);

// Alternate tool schemas for shape/semantic rows.
const TWO_REQ = {
    type: 'object',
    properties: { a: { type: 'string' }, b: { type: 'string' } },
    required: ['a', 'b'],
    additionalProperties: false,
};
const ARRAY_SCHEMA = {
    type: 'array',
    items: { type: 'object', properties: { path: { type: 'string' } } },
};
const PERMISSIVE = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    // additionalProperties omitted → defaults true → extra keys tolerated.
};
const schemaFn = (s: unknown) => async () => s;

describe('matrix — request assembly (exact args/schema/system/user threading)', () => {
    it('threads model, abortSignal, the validated output channel, and the schema resolver', async () => {
        const model = { __resolved: true } as any;
        const abortSignal = new AbortController().signal;
        const isFn = jest.fn(async () => TOOL_SCHEMA);
        mockGenerate.mockResolvedValueOnce({
            experimental_output: { path: 'a.ts' },
        });

        await repairInvalidToolInput({
            model,
            abortSignal,
            toolCall,
            inputSchema: isFn,
            error: validationError,
        });

        const args = mockGenerate.mock.calls[0][0];
        expect(args.model).toBe(model);
        expect(args.abortSignal).toBe(abortSignal); // row 34 — abortSignal threaded
        expect(args).toHaveProperty('output'); // Output.object structured channel present
        expect(isFn).toHaveBeenCalledWith({ toolName: toolCall.toolName });
    });

    it('builds the correction prompt from toolName + invalid args + the validation message', async () => {
        mockGenerate.mockResolvedValueOnce({
            experimental_output: { path: 'a.ts' },
        });
        await call();
        const prompt: string = mockGenerate.mock.calls[0][0].prompt;
        expect(prompt).toContain(toolCall.toolName);
        expect(prompt).toContain(JSON.stringify(toolCall.input));
        expect(prompt).toContain(validationError.message);
        expect(prompt).toContain(
            'Return corrected arguments that satisfy the schema',
        );
    });

    it('degrades a non-Error `error` to String(error) in the prompt (never crashes assembly)', async () => {
        mockGenerate.mockResolvedValueOnce({
            experimental_output: { path: 'a.ts' },
        });
        await call({ error: 'raw string failure' as any });
        expect(mockGenerate.mock.calls[0][0].prompt).toContain(
            'raw string failure',
        );
    });
});

describe('matrix A/B — success path (L1): readOutput envelope + verbatim stringify', () => {

    it('row 4 — SDK envelope variant: reads ai@7 `output` when experimental_output is absent', async () => {
        mockGenerate.mockResolvedValueOnce({ output: { path: 'src/o.ts' } });
        const out = await call();
        expect(out).toEqual({
            ...toolCall,
            input: JSON.stringify({ path: 'src/o.ts' }),
        });
    });

    it('row 13 — extra keys on the tool call are preserved (spread, not dropped)', async () => {
        const tc = {
            toolName: 'read_file',
            input: { pat: 'typo' },
            toolCallId: 'call_123',
        };
        mockGenerate.mockResolvedValueOnce({
            experimental_output: { path: 'x.ts' },
        });
        const out = await call({ toolCall: tc });
        expect(out!.toolCallId).toBe('call_123');
        expect(out!.input).toBe(JSON.stringify({ path: 'x.ts' }));
    });
});

describe('matrix A/B/C — salvage path (L2): deterministic recovery over raw text', () => {

    it('row 3 — single object when the tool expects an array → null', async () => {
        mockGenerate.mockRejectedValueOnce(parseFail('{"path":"x"}'));
        expect(await call({ inputSchema: schemaFn(ARRAY_SCHEMA) })).toBeNull();
    });

    it('row 10 — right data, renamed keys → null', async () => {
        mockGenerate.mockRejectedValueOnce(
            parseFail('```json\n{"filepath":"x"}\n```'),
        );
        expect(await call()).toBeNull();
    });

    it('row 12 — partial object (missing a required key) → null', async () => {
        mockGenerate.mockRejectedValueOnce(parseFail('{"a":"x"}'));
        expect(await call({ inputSchema: schemaFn(TWO_REQ) })).toBeNull();
    });

    it('row 13 — extra keys tolerated when the schema is permissive (recovered)', async () => {
        mockGenerate.mockRejectedValueOnce(
            parseFail('{"path":"src/e.ts","note":"extra"}'),
        );
        const out = await call({ inputSchema: schemaFn(PERMISSIVE) });
        expect(out!.input).toBe(
            JSON.stringify({ path: 'src/e.ts', note: 'extra' }),
        );
    });

});

describe('matrix C — transport / fail-safe (never throws past the boundary)', () => {
    it('row 28 — truncated JSON (unbalanced) → null', async () => {
        mockGenerate.mockRejectedValueOnce(parseFail('{"path":"x"'));
        expect(await call()).toBeNull();
    });

});

describe('matrix — known silent degradations (#1786 class) pinned as it.failing', () => {
    // repair-tool-call.ts:65 — the success path does `JSON.stringify(readOutput(result))`
    // with NO guard. When `readOutput` yields undefined (envelope with neither
    // experimental_output nor output), JSON.stringify(undefined) === undefined, so
    // the boundary returns `{...toolCall, input: undefined}` — a NON-null "repaired"
    // call carrying garbage instead of signalling failure. Correct behavior = null.
    it.failing(
        'row 32 — empty-success envelope ({}) should signal null, not ship input:undefined',
        async () => {
            mockGenerate.mockResolvedValueOnce({}); // no experimental_output/output
            expect(await call()).toBeNull();
        },
    );

    it.failing(
        'row 17 — a null/undefined generateText result should signal null, not ship input:undefined',
        async () => {
            mockGenerate.mockResolvedValueOnce(null as any);
            expect(await call()).toBeNull();
        },
    );

    // repair-tool-call.ts:44-46 — `await inputSchema(...)` and `ensureValidatingSchema`
    // run OUTSIDE the try block. A rejecting schema resolver therefore throws PAST the
    // boundary, violating the documented "ANY error resolves to null" contract.
    it.failing(
        'fail-soft when the schema resolver rejects (currently throws past the boundary)',
        async () => {
            const out = await repairInvalidToolInput({
                model: {} as any,
                toolCall,
                inputSchema: async () => {
                    throw new Error('schema resolver down');
                },
                error: validationError,
            });
            expect(out).toBeNull();
        },
    );
});
