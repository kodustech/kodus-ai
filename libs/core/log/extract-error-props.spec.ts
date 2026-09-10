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

    it('allowlists fields — requestBodyValues and data never reach the log', () => {
        // Mirrors @ai-sdk/provider's APICallError shape, which also carries
        // requestBodyValues (the full request payload for a review call) and
        // data. Object.keys(error) minus name/message/stack would dump both
        // uncapped; the allowlist must drop them.
        class APICallErrorLike extends Error {
            constructor(
                readonly statusCode: number,
                readonly responseBody: string,
                readonly url: string,
                readonly requestBodyValues: unknown,
                readonly data: unknown,
            ) {
                super('provider failed');
                this.name = 'APICallError';
            }
        }

        const err = new APICallErrorLike(
            429,
            '{"error":"slow down"}',
            'https://api.gateway.invalid',
            { messages: ['x'.repeat(50_000)] },
            { metadata: 'y'.repeat(50_000) },
        );

        const props = extractErrorProps(err, 2_000);

        expect(props.statusCode).toBe(429);
        expect(props.responseBody).toBe('{"error":"slow down"}');
        expect(props.url).toBe('https://api.gateway.invalid');
        expect(props.requestBodyValues).toBeUndefined();
        expect(props.data).toBeUndefined();
    });

    it('sanitizes BEFORE truncating so a long credential-shaped string is still redacted', () => {
        // A credential embedded in a URL that would have been substring()'d
        // past redaction under the old order.
        const longUrl = 'mongodb://user:sekret@host/db' + 'x'.repeat(5_000);
        const err = new AIAPICallError(
            401,
            longUrl,
            'https://api.gateway.invalid',
        );

        const props = extractErrorProps(err, 2_000);

        expect(props.responseBody).not.toContain('sekret');
        expect(props.responseBody as string).toContain('[REDACTED]');
        expect(props.responseBody as string).toHaveLength(2000 + 1);
    });

    it('surfaces in-repo scalar diagnostics (status, modelName, contextWindow) while still dropping heavy payload props', () => {
        // Mirrors the in-repo error shapes that attach small scalar own props
        // (azure `status`, llm context-window errors `contextWindow`/`modelName`)
        // plus a heavy `requestBodyValues` — the allowlist must keep the
        // scalars AND still drop the payload.
        class InRepoError extends Error {
            constructor(
                readonly status: number,
                readonly contextWindow: number,
                readonly modelName: string,
                readonly requestBodyValues: unknown,
            ) {
                super('model context too small');
            }
        }

        const err = new InRepoError(404, 128_000, 'gpt-4o', {
            messages: ['x'.repeat(50_000)],
        });

        const props = extractErrorProps(err, 2_000);

        expect(props.status).toBe(404);
        expect(props.contextWindow).toBe(128_000);
        expect(props.modelName).toBe('gpt-4o');
        expect(props.requestBodyValues).toBeUndefined();
    });

    it('returns nothing for a plain Error with no own extra props', () => {
        expect(extractErrorProps(new Error('plain failure'), 2_000)).toEqual({});
    });
});