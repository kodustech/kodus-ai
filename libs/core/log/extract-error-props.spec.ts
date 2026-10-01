// The global test setup mocks the logger module to silence logs (pino's
// worker-thread transport is not jest-friendly). This spec tests the real
// error serialization, so opt out of that mock and load the actual module via a
// deferred require (after jest.resetModules) so the unmock takes effect.
jest.unmock('@libs/core/log/logger');
jest.resetModules();

const { boundErrorForLog, extractErrorProps } = require('./logger');

describe('extractErrorProps (#1829)', () => {
    // BYOK provider errors attach statusCode / responseBody / url as own
    // (enumerable) props of the Error subclass.
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

    it('extracts the allowlisted own props of the Error subclass', () => {
        const err = new AIAPICallError(
            400,
            '{"error":"model not found"}',
            'https://api.gateway.invalid/v1',
        );

        const props = extractErrorProps(err);

        expect(props.statusCode).toBe(400);
        expect(props.url).toBe('https://api.gateway.invalid/v1');
        // prototype fields are intentionally excluded
        expect(props.name).toBeUndefined();
        expect(props.message).toBeUndefined();
        expect(props.stack).toBeUndefined();
    });

    it('never emits the raw provider response body, only its length', () => {
        // #1835 review: responseBody is the provider's raw HTTP body. It stays
        // out of the log line entirely (logging policy); the derived length is
        // what operators can alert on.
        const body = '{"error":"invalid api key sk-secret-value"}';
        const err = new AIAPICallError(
            401,
            body,
            'https://api.gateway.invalid',
        );

        const props = extractErrorProps(err);

        expect(props.responseBody).toBeUndefined();
        expect(props.responseBodyLength).toBe(body.length);
        expect(JSON.stringify(props)).not.toContain('sk-secret-value');
    });

    it('truncates oversized allowlisted string props to keep the log line sane', () => {
        const err = new AIAPICallError(
            401,
            'body',
            `https://api.gateway.invalid/${'x'.repeat(10_000)}`,
        );

        const props = extractErrorProps(err);

        expect(props.url).toHaveLength(2000 + 1); // truncated + ellipsis
        expect((props.url as string).endsWith('…')).toBe(true);
        expect(props.statusCode).toBe(401);
    });

    it('sanitizes BEFORE truncating so a long credential-shaped string is still redacted', () => {
        // A credential embedded in a URL that would have been substring()'d
        // past redaction under the old order.
        const longUrl = 'mongodb://user:sekret@host/db?x=' + 'y'.repeat(5_000);
        const err = new AIAPICallError(401, 'body', longUrl);

        const props = extractErrorProps(err);

        expect(props.url).not.toContain('sekret');
        expect(props.url as string).toContain('[REDACTED]');
        expect(props.url as string).toHaveLength(2000 + 1);
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

        const props = extractErrorProps(err);

        expect(props.statusCode).toBe(429);
        expect(props.url).toBe('https://api.gateway.invalid');
        expect(props.requestBodyValues).toBeUndefined();
        expect(props.data).toBeUndefined();
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

        const props = extractErrorProps(err);

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
        );

        expect(props.gate).toBe('self-review');
        expect(typeof props.target).toBe('string');
        expect(props.target as string).toHaveLength(2000 + 1);
        expect((props.target as string).endsWith('…')).toBe(true);
    });

    it('keeps small non-scalar props as objects; oversizing degrades to a bounded string', () => {
        // Shape contract: a small non-scalar allowlisted prop keeps its
        // sanitized object shape so nested log queries
        // (`error.target.organizationAndTeamData`) keep resolving; only an
        // oversized value degrades to a bounded JSON string. Shape is
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
        );

        expect(props.statusCode).toBe(429); // scalar stays a number
        expect(props.target).toEqual({ triggerCommentId: 'c1' }); // small → object
    });

    it('always hands pino a serializable value, including BigInt-bearing props', () => {
        // #1835 review: the old fallback returned the sanitized clone as-is, so
        // a BigInt inside it made the WHOLE log line throw on pino's stringify
        // and degrade to the console fallback, losing traceId/metadata for
        // exactly the error being described. The emitted value must always
        // serialize.
        class WeirdError extends Error {
            constructor(readonly target: unknown) {
                super('weird prop');
            }
        }

        const onSerializeFailed = jest.fn();
        const props = extractErrorProps(
            new WeirdError({
                organizationAndTeamData: { organizationId: 'org-1' },
                payload: { big: 12345678901234567890n },
            }),
            2_000,
            onSerializeFailed,
        );

        expect(() => JSON.stringify(props.target)).not.toThrow();
        expect(JSON.stringify(props.target)).toContain('12345678901234567890n');
        // Serializing it safely is not a failure: nothing to warn about.
        expect(onSerializeFailed).not.toHaveBeenCalled();
    });

    it('stays bounded (and never throws) for a deeply nested oversized prop', () => {
        class WeirdError extends Error {
            constructor(readonly target: unknown) {
                super('weird prop');
            }
        }

        const deep: Record<string, unknown> = { level: 0 };
        let cursor = deep;
        for (let i = 1; i < 60; i++) {
            cursor.next = { level: i };
            cursor = cursor.next as Record<string, unknown>;
        }
        cursor.blob = 'x'.repeat(20_000);

        const props = extractErrorProps(new WeirdError(deep));

        expect(() => JSON.stringify(props.target)).not.toThrow();
        expect(JSON.stringify(props.target).length).toBeLessThanOrEqual(
            2000 + 1,
        );
    });

    it('still redacts secrets from a capped prop instead of leaking the raw value', () => {
        class WeirdError extends Error {
            constructor(readonly target: unknown) {
                super('weird prop');
            }
        }

        // The fixture has to cross the 2,000-character cap, otherwise the
        // degradation path this case is named for (sanitize, then clamp to a
        // bounded JSON string) never runs, and the case stays green even with the
        // sanitize-before-clamp guard reverted.
        const props = extractErrorProps(
            new WeirdError({
                authorization: 'Bearer sk-live-credential',
                token: 'leak-me',
                nested: { cookie: 'session=leak-me-too' },
                padding: 'x'.repeat(4_000),
            }),
        );

        const emitted = JSON.stringify(props.target);
        // The prop really degraded to the bounded string form…
        expect(typeof props.target).toBe('string');
        expect(emitted.length).toBeLessThan(2_500);
        // …and the secrets inside it were still redacted.
        expect(emitted).not.toContain('sk-live-credential');
        expect(emitted).not.toContain('leak-me');
    });

    it('returns nothing for a plain Error with no own extra props', () => {
        expect(extractErrorProps(new Error('plain failure'))).toEqual({});
    });
});

describe('boundErrorForLog (#1835 review)', () => {
    // The `err.*` serializer is the other path an error's own props travel:
    // pino's stdSerializer copies every enumerable own prop, uncapped, which is
    // how a provider payload (requestBodyValues = the whole prompt, data, the
    // raw responseBody) used to reach the log line.
    class APICallErrorLike extends Error {
        constructor(
            readonly statusCode: number,
            readonly responseBody: string,
            readonly url: string,
            readonly responseHeaders: unknown,
            readonly requestBodyValues: unknown,
            readonly data: unknown,
        ) {
            super('provider failed');
            this.name = 'APICallError';
        }
    }

    it('keeps identity keys and scalars, drops heavy own props, replaces the raw body with its length', () => {
        const err = new APICallErrorLike(
            429,
            '{"error":"slow down"}',
            'https://api.gateway.invalid',
            { 'content-type': 'application/json' },
            { messages: ['x'.repeat(50_000)] },
            { metadata: 'y'.repeat(50_000) },
        );

        const bounded = boundErrorForLog(err);

        expect(bounded.message).toBe('provider failed');
        expect(bounded.stack).toBeDefined();
        expect(bounded.statusCode).toBe(429);
        expect(bounded.url).toBe('https://api.gateway.invalid');
        expect(bounded.responseBody).toBeUndefined();
        expect(bounded.responseBodyLength).toBe('{"error":"slow down"}'.length);
        expect(bounded.requestBodyValues).toBeUndefined();
        expect(bounded.data).toBeUndefined();
    });

    it('caps an allowlisted non-scalar prop and stays serializable', () => {
        class ReviewRefusalError extends Error {
            constructor(readonly target: unknown) {
                super('review refused');
            }
        }

        const bounded = boundErrorForLog(
            new ReviewRefusalError({
                organizationAndTeamData: { organizationId: 'org-1' },
                pullRequest: { body: 'x'.repeat(10_000) },
            }),
        );

        expect(() => JSON.stringify(bounded)).not.toThrow();
        // The prop itself is bounded (the cap is per prop; identity keys like
        // the stack keep their own size). 10 KB went in, ~2 KB comes out.
        expect(JSON.stringify(bounded.target).length).toBeLessThan(2_500);
    });

    it('keeps only the HTTP status and URL from an axios-shaped error', () => {
        // #1835 review: dropping every non-allowlisted non-scalar removed the
        // two fields operators alert on (err.response.status, err.config.url)
        // while the response content must still not travel with them.
        const err = Object.assign(new Error('request failed'), {
            response: {
                status: 503,
                statusText: 'Service Unavailable',
                data: { raw: 'provider payload' },
                headers: { 'set-cookie': 'cookie=leak-me' },
            },
            config: {
                method: 'post',
                url: 'https://api.gateway.invalid/v1/chat',
                data: { prompt: 'the whole prompt' },
                headers: { 'x-api-key': 'leak-me-too' },
            },
        });

        const bounded = boundErrorForLog(err);
        const emitted = JSON.stringify(bounded);

        expect(bounded.response).toEqual({
            status: 503,
            statusText: 'Service Unavailable',
        });
        expect(bounded.config).toEqual({
            method: 'post',
            url: 'https://api.gateway.invalid/v1/chat',
        });
        expect(emitted).not.toContain('provider payload');
        expect(emitted).not.toContain('the whole prompt');
        expect(emitted).not.toContain('leak-me');
    });

    it('never emits the provider response headers on either path', () => {
        // Same reasoning as responseBody: a headers collection carries
        // set-cookie / www-authenticate / custom api-key names, and None of that
        // is caught by key-name redaction once it is a value under a safe key.
        const err = new APICallErrorLike(
            401,
            '{"error":"unauthorized"}',
            'https://api.gateway.invalid',
            { 'set-cookie': 'cookie=leak-me', 'x-api-key': 'leak-me-too' },
            {},
            {},
        );

        const bounded = boundErrorForLog(err);
        const props = extractErrorProps(err);

        expect(bounded.responseHeaders).toBeUndefined();
        expect(props.responseHeaders).toBeUndefined();
        expect(JSON.stringify({ bounded, props })).not.toContain('leak-me');
    });

    it('turns a primitive err into a message instead of enumerating it', () => {
        // `error: err.message` is a documented call shape: pino's serializer
        // would hand back {'0':'R','1':'e',…} for a string, and
        // Object.entries(null) throws outright.
        const bounded = boundErrorForLog('Request failed with status 500');

        expect(bounded).toEqual({
            message: 'Request failed with status 500',
        });
        expect(JSON.stringify(bounded)).not.toContain('"0"');
        expect(boundErrorForLog(null)).toEqual({});
        expect(boundErrorForLog(undefined)).toEqual({});
    });

    it('passes an unset optional allowlisted prop through without a marker', () => {
        // An error subclass that assigns `this.target = target` unconditionally
        // used to emit '[unserializable value]' plus one warning per occurrence.
        class RefusalError extends Error {
            constructor() {
                super('refused');
                (this as unknown as Record<string, unknown>).target = undefined;
            }
        }

        const onSerializeFailed = jest.fn();
        const bounded = boundErrorForLog(new RefusalError());
        const props = extractErrorProps(
            new RefusalError(),
            2_000,
            onSerializeFailed,
        );

        expect(bounded.target).toBeUndefined();
        expect(JSON.stringify(bounded)).not.toContain('unserializable');
        expect(props.target).toBeUndefined();
        expect(onSerializeFailed).not.toHaveBeenCalled();
    });

    it('redacts a credential that straddles the clamp instead of emitting a fragment', () => {
        // Clamping before sanitizing cut the pair mid-token: the first 2,000
        // characters carried the token prefix in cleartext, and the later
        // deepSanitize pass cannot redact a pair whose closing quote is gone.
        const secret = `sk-live-${'A'.repeat(3_000)}`;
        const straddling = `{"apiKey":"${secret}"}`.padEnd(4_500, 'z');
        const err = new APICallErrorLike(
            500,
            '{"error":"boom"}',
            straddling,
            {},
            {},
            {},
        );

        const bounded = boundErrorForLog(err);
        const props = extractErrorProps(err);

        expect(JSON.stringify(bounded)).not.toContain('sk-live-');
        expect(JSON.stringify(props)).not.toContain('sk-live-');
        expect(String(bounded.url).length).toBeLessThanOrEqual(2_001);
    });

    it('redacts a pair whose closing delimiter falls PAST the old scan window', () => {
        // The case above closes its pair at ~3 KB, INSIDE the 4,000-character
        // window the bounded scan used, which is why it passed while the window
        // existed. Push the closing quote past it — the pair opens inside the
        // emitted prefix and closes outside the scan — and the prefix went out in
        // the clear, because neither JSON_PAIR_PATTERN nor redactUrlUserinfo can
        // match a pair that never closes. Same shape the review reported
        // (`err.url = '{"apiKey":"' + 'A'.repeat(4_500) + '"}'`); the scan is the
        // whole value now, so both paths redact it.
        const err = new APICallErrorLike(
            500,
            '{"error":"boom"}',
            `{"apiKey":"${'A'.repeat(4_500)}"}`,
            {},
            {},
            {},
        );

        const bounded = boundErrorForLog(err);
        const props = extractErrorProps(err);

        expect(String(bounded.url)).not.toContain('AAAA');
        expect(JSON.stringify(props)).not.toContain('AAAA');
        // Still clamped to the log-line budget.
        expect(String(bounded.url).length).toBeLessThanOrEqual(2_001);
    });

    it('redacts the same far-closing pair on the axios url kept by pickHttpContext', () => {
        // The second site the review named: the `config.url` that survives the
        // allowlist is sanitized by `pickHttpContext`, which had the identical
        // scan-then-clamp order. Fixed in the same place, pinned here so the two
        // paths cannot drift apart again.
        const err = Object.assign(new Error('request failed'), {
            response: { status: 503 },
            config: {
                method: 'post',
                url: `{"apiKey":"${'B'.repeat(4_500)}"}`,
            },
        });

        const bounded = boundErrorForLog(err);

        expect(JSON.stringify(bounded)).not.toContain('BBBB');
        expect(
            String((bounded.config as Record<string, unknown>).url).length,
        ).toBeLessThanOrEqual(2_001);
    });
});
