// The global test setup mocks the logger module to silence logs (pino's
// worker-thread transport is not jest-friendly). This spec tests the real
// error serializer, so opt out of that mock and load the actual module via a
// deferred require (after jest.resetModules) so the unmock takes effect.
jest.unmock('@libs/core/log/logger');
jest.resetModules();

const { extractErrorProps } = require('./logger');

describe('extractErrorProps (#1829)', () => {
    // BYOK provider errors attach statusCode / responseBody / url as own
    // (enumerable) props of the Error subclass, which pino's default `err`
    // serializer drops. The serializer must surface them generically.
    class AIAPICallError extends Error {
        public readonly statusCode: number;
        public readonly responseBody: string;
        public readonly url: string;

        constructor(statusCode: number, responseBody: string, url: string) {
            super(responseBody);
            this.name = 'AI_APICallError';
            this.statusCode = statusCode;
            this.responseBody = responseBody;
            this.url = url;
        }
    }

    it('extracts enumerable own props of the Error subclass', () => {
        const err = new AIAPICallError(
            400,
            '{"error":"model not found"}',
            'https://api.gateway.invalid/v1',
        );

        const props = extractErrorProps(err, 2_000);

        expect(props.statusCode).toBe(400);
        expect(props.responseBody).toBe('{"error":"model not found"}');
        expect(props.url).toBe('https://api.gateway.invalid/v1');
        // prototype fields are intentionally excluded
        expect(props.name).toBeUndefined();
        expect(props.message).toBeUndefined();
        expect(props.stack).toBeUndefined();
    });

    it('truncates oversized string props to keep the log line sane', () => {
        const err = new AIAPICallError(
            401,
            'x'.repeat(10_000),
            'https://api.gateway.invalid',
        );

        const props = extractErrorProps(err, 2_000);

        expect(props.responseBody).toHaveLength(2000 + 1); // truncated + ellipsis
        expect((props.responseBody as string).endsWith('…')).toBe(true);
        expect(props.statusCode).toBe(401);
        expect(props.url).toBe('https://api.gateway.invalid');
    });

    it('returns nothing for a plain Error with no own extra props', () => {
        expect(extractErrorProps(new Error('plain failure'), 2_000)).toEqual({});
    });
});