import { JSONParseError, NoObjectGeneratedError, TypeValidationError } from 'ai';
import { z } from 'zod';

import { validatedSdkOutput } from './structured-review-call';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { textTokens: 1, reasoningTokens: 0 } };
const Severity = z.object({ severity: z.enum(['low', 'high']) });

// An SDK answer is checked against the schema Output.object uses, and a bad one
// raises what generateText raises for it, so the caller's recovery runs.
describe('validatedSdkOutput', () => {
    it('returns the structured object when it fits, or the JSON text when no object came back', async () => {
        expect(await validatedSdkOutput({ text: '', output: { severity: 'low' }, usage, finishReason: 'stop' }, Severity)).toEqual({ severity: 'low' });
        expect(await validatedSdkOutput({ text: '{"severity":"high"}', usage, finishReason: 'stop' }, Severity)).toEqual({ severity: 'high' });
    });

    it('a wrong shape is a NoObjectGeneratedError caused by a TypeValidationError, carrying the text', async () => {
        const err = await validatedSdkOutput({ text: '{"severity":"nope"}', output: { severity: 'nope' }, usage, finishReason: 'stop' }, Severity).catch((e) => e);
        expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
        expect(TypeValidationError.isInstance(err.cause)).toBe(true);
        expect(err.text).toBe('{"severity":"nope"}');
    });

    it('text that is not JSON is a NoObjectGeneratedError caused by a JSONParseError', async () => {
        const err = await validatedSdkOutput({ text: 'severity: high', usage, finishReason: 'stop' }, Severity).catch((e) => e);
        expect(NoObjectGeneratedError.isInstance(err)).toBe(true);
        expect(JSONParseError.isInstance(err.cause)).toBe(true);
    });
});
