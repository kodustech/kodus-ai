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

    it('caps an oversized object prop instead of dumping it whole', () => {
        // `target` is the CommandReviewFeedbackTarget object attached on a
        // `@kody review` refusal. Non-scalar values used to bypass the 2KB cap
        // entirely, so every refusal embedded the whole target on the line.
        class ReviewRefusalError extends Error {
            constructor(
                readonly gate: string,
                readonly target: unknown,
            ) {
                super('review refused');
            }
        }

        const target = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: { id: 'r1', name: 'repo' },
            pullRequest: { number: 42, body: 'x'.repeat(10_000) },
            triggerCommentId: 'c1',
        };

        const props = extractErrorProps(
            new ReviewRefusalError('self-review', target),
            2_000,
        );

        expect(props.gate).toBe('self-review');
        expect(typeof props.target).toBe('string');
        expect(props.target as string).toHaveLength(2000 + 1);
        expect((props.target as string).endsWith('…')).toBe(true);
    });

    it('keeps small non-scalar props as objects; oversizing degrades to a bounded string', () => {
        // Shape contract (#4003924218 + #4012208372): a small non-scalar
        // allowlisted prop keeps its SANITIZED object shape so nested log
        // queries (`error.target.organizationAndTeamData`) keep resolving;
        // only an oversized value degrades to a bounded JSON string. Shape is
        // deterministic by size, never by luck of the payload.
        class ReviewRefusalError extends Error {
            constructor(
                readonly statusCode: number,
                readonly target: unknown,
            ) {
                super('review refused');
            }
        }

        const props = extractErrorProps(
            new ReviewRefusalError(429, { triggerCommentId: 'c1' }),
            2_000,
        );

        expect(props.statusCode).toBe(429); // scalar stays a number
        expect(props.target).toEqual({ triggerCommentId: 'c1' }); // small → object
    });

    it('reports (warns, not silent) when a non-scalar prop cannot be serialized', () => {
        // #4003923790: a catch that just returns the raw value is a silent
        // failure. A non-serializable leaf (BigInt) must surface through the
        // reporter — in production that is warnSerializeFailure, a module-local
        // pino warn (no PinoLoggerService import → no core→app dependency
        // cycle), carrying maxStringLength + org id when available.
        class WeirdError extends Error {
            constructor(readonly target: unknown) {
                super('weird prop');
            }
        }

        const onSerializeFailed = jest.fn();
        const props = extractErrorProps(
            new WeirdError({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                payload: { big: 12345678901234567890n },
            }),
            2_000,
            onSerializeFailed,
        );

        expect(onSerializeFailed).toHaveBeenCalledTimes(1);
        expect(onSerializeFailed).toHaveBeenCalledWith(
            expect.objectContaining({
                maxStringLength: 2_000,
                organizationId: 'org-1',
            }),
        );
        // The prop is not dropped entirely — it falls back to the sanitized
        // clone, and the drop is now logged upstream instead of being invisible.
        expect(props.target).toBeDefined();
    });

    it('still redacts secrets from a non-serializable prop instead of leaking the raw value', () => {
        // #4012208143: signing sub-errors that can't serialize (BigInt) must
        // fall back to the SANITIZED clone, never the raw value. Otherwise a
        // credential that deepSanitize redacted is emitted back in cleartext.
        class WeirdError extends Error {
            constructor(readonly target: unknown) {
                super('weird prop');
            }
        }

        const props = extractErrorProps(
            new WeirdError({
                authorization: 'Bearer sk-secret-123',
                token: 'leak-me',
            }),
            2_000,
        );

        const emitted = JSON.stringify(props.target);
        expect(emitted).not.toContain('sk-secret-123');
        expect(emitted).not.toContain('leak-me');
    });

    it('returns nothing for a plain Error with no own extra props', () => {
        expect(extractErrorProps(new Error('plain failure'), 2_000)).toEqual(
            {},
        );
    });
});
