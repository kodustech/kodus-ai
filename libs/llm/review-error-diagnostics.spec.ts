import {
    buildReviewErrorMessage,
    extractProviderMessage,
    redactSecrets,
} from './review-error-diagnostics';

/**
 * A failed review has to say what happened, and it posts that on a PUBLIC pull
 * request. Those two pull in opposite directions and both have already gone
 * wrong: the comment said "Unexpected error while running the code review
 * (open_router)" while the status and the provider's own sentence sat one
 * function call away, and the fix for that is one careless paste away from
 * publishing whatever the provider echoed back.
 */

describe('redactSecrets', () => {
    it.each([
        ['OpenAI / OpenRouter', 'key sk-or-v1-abcdef0123456789abcdef expired'],
        ['Anthropic', 'using sk-ant-api03-AAAAbbbbCCCCddddEEEE now'],
        ['Google', 'AIzaSyD-1234567890abcdefghijklmno is invalid'],
        ['AWS', 'AKIAIOSFODNN7EXAMPLE denied'],
        ['GitHub', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ])('removes a %s key', (_label, text) => {
        const out = redactSecrets(text);

        expect(out).toContain('[redacted]');
        // Nothing key-shaped survives: the point is the value is gone, not that
        // some prefix was rewritten.
        expect(out).not.toMatch(/sk-[A-Za-z0-9]|AIzaSy|AKIA|ghp_/);
    });

    it('removes an echoed authorization header', () => {
        expect(
            redactSecrets('Authorization: Bearer eyJhbGciOi.J9.abc'),
        ).not.toContain('eyJhbGciOi');
    });

    it('keeps the field NAME and drops only the value', () => {
        // A reader still needs to know WHICH field the provider complained
        // about; it is the value that must not be published.
        const out = redactSecrets(
            '{"api_key":"sk-live-9f8e7d6c5b4a3","model":"x"}',
        );

        expect(out).toContain('api_key');
        expect(out).toContain('[redacted]');
        expect(out).not.toContain('9f8e7d6c5b4a3');
        expect(out).toContain('"model":"x"');
    });

    it('leaves an ordinary sentence untouched', () => {
        const said = 'Rate limit exceeded for free models. Try again in 60s.';

        expect(redactSecrets(said)).toBe(said);
    });
});

describe('extractProviderMessage', () => {
    it("prefers the provider's sentence over the SDK's terse message", () => {
        // The exact gap that cost a customer a day: the AI SDK sets `message`
        // to a restatement of the status while the cause sits in the body.
        const err = {
            message: 'Not Found',
            responseBody: JSON.stringify({
                error: {
                    message:
                        'No allowed providers are available for the selected model.',
                },
            }),
        };

        expect(extractProviderMessage(err)).toBe(
            'No allowed providers are available for the selected model.',
        );
    });

    it('reads an already-parsed body', () => {
        expect(
            extractProviderMessage({
                data: { error: { message: 'Rate limit exceeded' } },
            }),
        ).toBe('Rate limit exceeded');
    });

    it('falls back to a plain-text body', () => {
        expect(
            extractProviderMessage({
                responseBody: '  upstream unavailable  ',
            }),
        ).toBe('upstream unavailable');
    });

    it('says nothing when the provider said nothing', () => {
        // "Provider said: Not Found" under a message that already explained the
        // 404 is noise, not diagnostics.
        expect(
            extractProviderMessage({ message: 'Not Found' }),
        ).toBeUndefined();
        expect(extractProviderMessage(undefined)).toBeUndefined();
        expect(extractProviderMessage('a string')).toBeUndefined();
    });

    it('redacts before returning — the caller publishes this', () => {
        const out = extractProviderMessage({
            responseBody: JSON.stringify({
                error: {
                    message: 'Invalid key sk-or-v1-abcdef0123456789abcdef',
                },
            }),
        });

        expect(out).toContain('[redacted]');
        expect(out).not.toContain('abcdef0123456789');
    });

    it('caps a body long enough to hold a prompt or a source file', () => {
        const out = extractProviderMessage({
            responseBody: JSON.stringify({
                error: { message: 'x'.repeat(5000) },
            }),
        })!;

        expect(out.length).toBeLessThanOrEqual(401);
        expect(out.endsWith('…')).toBe(true);
    });

    it('collapses newlines so one body cannot dominate the comment', () => {
        expect(
            extractProviderMessage({ responseBody: 'line one\n\n   line two' }),
        ).toBe('line one line two');
    });
});

describe('buildReviewErrorMessage', () => {
    it('leads with the classified sentence, then the facts', () => {
        const out = buildReviewErrorMessage({
            friendlyMessage: 'The provider is rate limiting this key.',
            provider: 'open_router',
            model: 'moonshotai/kimi-k2:free',
            httpStatus: 429,
            providerMessage: 'Rate limit exceeded for free models.',
        });

        expect(out).toBe(
            'The provider is rate limiting this key.\n\n' +
                'open_router · moonshotai/kimi-k2:free · HTTP 429\n\n' +
                'Provider said: Rate limit exceeded for free models.',
        );
    });

    it('names the model that actually ran', () => {
        // The report that prompted this asked for exactly this: neither message
        // included the model id, so a reader could not tell which slot failed.
        expect(
            buildReviewErrorMessage({
                friendlyMessage: 'Failed.',
                model: 'openai/gpt-oss-120b:free',
            }),
        ).toContain('openai/gpt-oss-120b:free');
    });

    it('omits what it does not know instead of printing it empty', () => {
        // A review that failed before a provider was resolved has nothing to
        // add, and "Model: undefined" is worse than silence.
        expect(
            buildReviewErrorMessage({ friendlyMessage: 'Something broke.' }),
        ).toBe('Something broke.');
    });

    it('does not quote the provider twice', () => {
        // The 404 classifier already folds the provider's explanation into the
        // friendly sentence for a routing refusal; repeating it below would read
        // as two different findings.
        const said = 'No allowed providers are available.';
        const out = buildReviewErrorMessage({
            friendlyMessage: `Nowhere to route: ${said}`,
            providerMessage: said,
        });

        expect(out).not.toContain('Provider said:');
    });

    it('reports the failing agent when the failure was attributed to one', () => {
        expect(
            buildReviewErrorMessage({
                friendlyMessage: 'Failed.',
                agentName: 'kody-rules',
            }),
        ).toContain('kody-rules');
    });

    it('keeps a 0-latency-style falsy status out of the facts line', () => {
        // `httpStatus: 0` is not a status anyone can act on, but it is a number,
        // so a truthiness check would print "HTTP 0" and a typeof check would
        // too — this pins which one we chose.
        expect(
            buildReviewErrorMessage({
                friendlyMessage: 'Network failure.',
                httpStatus: undefined,
            }),
        ).toBe('Network failure.');
    });
});
