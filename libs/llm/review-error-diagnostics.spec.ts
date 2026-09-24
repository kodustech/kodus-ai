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
        // Asserted on a STRUCTURED message: a raw body carrying blank lines
        // reads as a dump and is dropped outright by the prose gate below, so
        // this is the path where collapsing is what does the work.
        expect(
            extractProviderMessage({
                responseBody: JSON.stringify({
                    error: { message: 'line one\n\n   line two' },
                }),
            }),
        ).toBe('line one line two');
    });

    // A cap bounds how much of an echoed request leaks; it never decides
    // WHETHER it leaks, because truncation keeps the first 400 characters and
    // that is exactly where an echoed prompt begins. So a raw body has to read
    // as one plain sentence before any of it is published.
    describe('a raw body has to earn its way into a public comment', () => {
        const rawOf = (responseBody: string) =>
            extractProviderMessage({ responseBody });

        it('publishes a short plain-text explanation', () => {
            expect(rawOf('Upstream provider is temporarily unavailable.')).toBe(
                'Upstream provider is temporarily unavailable.',
            );
        });

        it('drops a body that echoes the request it rejected', () => {
            // Content filters quote the input they flagged. Truncating that
            // publishes the opening of the prompt rather than protecting it.
            const echoed =
                'Request rejected. Input was: ' +
                'function computeInternalPricing(customer) { return customer.tier * 1.7; } ' +
                'and the rest of the file followed';

            expect(rawOf(echoed)).toBeUndefined();
        });

        it('drops an unparsed payload the JSON reader could not read', () => {
            expect(
                rawOf('{"error": "truncated at the byte limit'),
            ).toBeUndefined();
            expect(
                rawOf('<html><body>502 Bad Gateway</body></html>'),
            ).toBeUndefined();
        });

        it('drops a multi-line dump', () => {
            expect(
                rawOf('Error: failed\n  at run (a.ts:1)\n  at main (b.ts:2)'),
            ).toBeUndefined();
        });

        it('drops anything long enough to be carrying content', () => {
            expect(rawOf('a '.repeat(200))).toBeUndefined();
        });

        it('still reads a STRUCTURED message of any shape — the provider named it', () => {
            // The gate is for raw bodies only: a field the provider itself
            // labelled `message` is a claim about what it is, and the cap plus
            // redaction cover it from there.
            expect(
                extractProviderMessage({
                    responseBody: JSON.stringify({
                        error: { message: 'x'.repeat(300) },
                    }),
                }),
            ).toHaveLength(300);
        });
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
