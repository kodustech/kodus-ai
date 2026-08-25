import { providerErrorFromResult } from './provider-error';

describe('providerErrorFromResult', () => {
    it('returns null for a healthy result', () => {
        expect(providerErrorFromResult({ finishReason: 'stop' })).toBeNull();
    });

    it('returns null for a non-error stop (timeout/budget)', () => {
        expect(providerErrorFromResult({ finishReason: 'timeout' })).toBeNull();
        expect(providerErrorFromResult(undefined)).toBeNull();
    });

    it('reconstructs a classifiable error carrying the provider message/name', () => {
        const err = providerErrorFromResult({
            finishReason: 'error',
            errorMessage: 'Not found the model kimi-x or Permission denied',
            errorName: 'AI_APICallError',
        });
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toContain('Not found the model kimi-x');
        expect(err!.name).toBe('AI_APICallError');
    });

    it('re-attaches upstream status + body for classifyLLMError', () => {
        const err = providerErrorFromResult({
            finishReason: 'error',
            errorMessage: 'Not Found',
            errorStatus: 404,
            errorResponseBody: '{"error":"model not found"}',
        }) as (Error & { statusCode?: number; responseBody?: string }) | null;
        expect(err?.statusCode).toBe(404);
        expect(err?.responseBody).toBe('{"error":"model not found"}');
    });

    it('falls back to a generic message when none is present', () => {
        const err = providerErrorFromResult({ finishReason: 'error' });
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toMatch(/provider call returned an error/i);
    });
});
