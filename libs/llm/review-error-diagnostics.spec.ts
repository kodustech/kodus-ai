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

    it('removes the account and key ids a Moonshot (Kimi) billing error echoes back (#2021)', () => {
        const out = redactSecrets(
            'Your account org-0123456789abcdef0123456789abcdef <ak-f00ba7f00ba7f00ba7> is suspended due to insufficient balance',
        );

        expect(out).not.toMatch(/org-[0-9a-f]{8}|ak-[a-z0-9]{8}/);
        expect(out).toContain('is suspended due to insufficient balance');
    });

    it('keeps a plain word that merely starts like an id', () => {
        expect(redactSecrets('the org-level setting is off')).toBe(
            'the org-level setting is off',
        );
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

describe('OpenRouter upstream errors (#1871)', () => {
    // OpenRouter answers an upstream failure with its own wrapper sentence and
    // puts the upstream answer in `error.metadata`. The AI SDK's error schema
    // drops `metadata` from `data`, so only `responseBody` still carries it.
    const openRouterError = (metadata: Record<string, unknown>) => ({
        message: 'Provider returned error',
        statusCode: 429,
        data: { error: { message: 'Provider returned error', code: 429 } },
        responseBody: JSON.stringify({
            error: { message: 'Provider returned error', code: 429, metadata },
        }),
    });

    it("quotes the upstream provider's plain-text reason, not OpenRouter's wrapper", () => {
        const out = extractProviderMessage(
            openRouterError({
                raw: 'google/gemma-3-27b-it:free is temporarily rate-limited upstream. Please retry shortly.',
                provider_name: 'Chutes',
            }),
        );
        expect(out).toBe(
            'Chutes: google/gemma-3-27b-it:free is temporarily rate-limited upstream. Please retry shortly.',
        );
    });

    it('reads the message field of an upstream JSON body kept as a string in metadata.raw', () => {
        const out = extractProviderMessage(
            openRouterError({
                raw: JSON.stringify({
                    error: {
                        message: 'Quota exceeded for model on this project.',
                        status: 'RESOURCE_EXHAUSTED',
                    },
                }),
                provider_name: 'Google AI Studio',
            }),
        );
        expect(out).toBe(
            'Google AI Studio: Quota exceeded for model on this project.',
        );
    });

    // What must not change: the upstream text gets the same publishing gate as
    // any other body, and a body without it reads as before.
    describe('impact: what must not change', () => {
        it('keeps the wrapper sentence when the upstream raw body is a payload, not prose', () => {
            const echoed =
                'Request rejected. Input was: ' +
                'function computeInternalPricing(customer) { return customer.tier * 1.7; } ' +
                'and the rest of the file followed';
            expect(
                extractProviderMessage(openRouterError({ raw: echoed })),
            ).toBe('Provider returned error');
        });

        it('never publishes the flagged input of a moderation error', () => {
            const out = extractProviderMessage(
                openRouterError({
                    reasons: ['violence'],
                    flagged_input: 'the user prompt that was flagged',
                    provider_name: 'OpenAI',
                }),
            );
            expect(out).toBe('Provider returned error');
        });

        it('never publishes a key the upstream body echoes', () => {
            const out = extractProviderMessage(
                openRouterError({
                    raw: 'Invalid key sk-or-v1-abcdef0123456789abcdef',
                }),
            );
            expect(out).not.toContain('abcdef0123456789');
        });

        it('reads an ordinary provider body exactly as before', () => {
            expect(
                extractProviderMessage({
                    data: { error: { message: 'Rate limit exceeded' } },
                    responseBody: JSON.stringify({
                        error: { message: 'Rate limit exceeded' },
                    }),
                }),
            ).toBe('Rate limit exceeded');
        });
    });
});

describe('extractProviderMessage — a wrapper with no body of its own', () => {
    // The shape the AI SDK throws for a provider's answer (APICallError).
    const apiError = (body: unknown) =>
        Object.assign(new Error('Too Many Requests'), {
            name: 'AI_APICallError',
            statusCode: 429,
            responseBody: JSON.stringify(body),
        });

    it("reads the provider's sentence from a RetryError's last attempt", () => {
        const retry = Object.assign(new Error('Failed after 3 attempts.'), {
            name: 'AI_RetryError',
            lastError: apiError({
                error: {
                    message: 'Rate limit reached for gpt-x on tokens per min',
                },
            }),
        });
        expect(extractProviderMessage(retry)).toBe(
            'Rate limit reached for gpt-x on tokens per min',
        );
    });

    it('reads it from the cause of our own wrapper error', () => {
        const wrapped = new Error('summary failed', {
            cause: apiError({ error: { message: 'Overloaded' } }),
        });
        expect(extractProviderMessage(wrapped)).toBe('Overloaded');
    });

    it('keeps redacting a key found on the last attempt', () => {
        const retry = Object.assign(new Error('Failed after 3 attempts.'), {
            lastError: apiError({
                error: {
                    message:
                        'Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
                },
            }),
        });
        const published = extractProviderMessage(retry);
        expect(published).toContain('Incorrect API key provided');
        expect(published).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    });

    it("reads the provider's sentence across a cause cycle and still terminates", () => {
        const a: any = new Error('wrapper');
        const b: any = apiError({ error: { message: 'Overloaded' } });
        a.cause = b;
        b.cause = a;
        expect(extractProviderMessage(a)).toBe('Overloaded');
        const c: any = new Error('c');
        const d: any = new Error('d');
        c.cause = d;
        d.cause = c;
        expect(extractProviderMessage(c)).toBeUndefined();
    });
});

// Review on #2700 (sartorijr92): each case is the reviewer's reproduction.
describe('extractProviderMessage: review on #2700', () => {
    const apiError = (body: unknown, statusCode = 429) =>
        Object.assign(new Error('Bad Request'), {
            name: 'AI_APICallError',
            statusCode,
            responseBody: JSON.stringify(body),
        });

    it("does not publish an upstream's labelled message that is a payload (vLLM's validation repr)", () => {
        const raw = JSON.stringify({
            object: 'error',
            message:
                "[{'type': 'string_type', 'loc': ('body','messages',1,'content','str'), 'msg': 'Input should be a valid string', 'input': [{'type':'text','text':'diff --git a/src/billing/pricing.ts const INTERNAL_MARGIN = 0.37'}]}]",
            type: 'BadRequestError',
        });
        const err = apiError(
            { error: { message: 'Provider returned error', metadata: { raw, provider_name: 'Chutes' } } },
            400,
        );
        expect(extractProviderMessage(err) ?? '').not.toContain('INTERNAL_MARGIN');
    });

    it("does not publish a quoted request from an upstream's detail", () => {
        const raw = JSON.stringify({
            detail: 'Invalid request: messages[0].content="def charge(card): return card.number"',
        });
        const err = apiError({ error: { message: 'Provider returned error', metadata: { raw } } }, 400);
        expect(extractProviderMessage(err) ?? '').not.toContain('card.number');
    });

    it("still quotes an upstream's plain sentence (#1871)", () => {
        const raw = JSON.stringify({ error: { message: 'Upstream rate-limited, retry in 30s' } });
        const err = apiError({ error: { message: 'Provider returned error', metadata: { raw, provider_name: 'Fireworks' } } });
        expect(extractProviderMessage(err)).toBe('Fireworks: Upstream rate-limited, retry in 30s');
    });

    it('does not publish the body of a cause that is not a provider error', () => {
        expect(
            extractProviderMessage({
                message: 'wrap',
                cause: { name: 'SomeError', body: 'connection refused to mongodb://admin:pw@10.0.0.5:27017' },
            }),
        ).toBeUndefined();
        expect(
            extractProviderMessage({ message: 'wrap', cause: { status: 404, data: { message: 'Not Found' } } }),
        ).toBeUndefined();
    });

    it("reads a RetryError's earlier attempt when the last one has no body", () => {
        const timeout = Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
        });
        const rateLimited = apiError({
            error: {
                message: 'Provider returned error',
                metadata: { raw: 'Upstream rate-limited, retry in 30s', provider_name: 'OpenRouter' },
            },
        });
        const retry = {
            name: 'AI_RetryError',
            reason: 'errorNotRetryable',
            message: 'Failed after 2 attempts.',
            errors: [rateLimited, timeout],
            lastError: timeout,
        };
        expect(extractProviderMessage(retry)).toBe('OpenRouter: Upstream rate-limited, retry in 30s');
    });

    it.each([
        ['a Google AI Studio auth key', 'Invalid API key provided: AQ.Ab8RN6LkqZ3vT9xPqWcD2mF7sHjK'],
        ['a key in a query string', 'Request to https://generativelanguage.googleapis.com/v1/models?key=AQ.Ab8RN6LkqZ3vT9xPqWc failed'],
        ['a Bedrock API key', 'Invalid API key provided: ABSKQmVkcm9ja0FQSUtleS1leGFtcGxl'],
        ['a Fireworks key', 'Invalid API key provided: fw_3ZkV8mQ2xR7tY1nB5cL9'],
        ['a Together key', 'Invalid API key provided: tgp_v1_Zk3V8mQ2xR7tY1nB5cL9wQ'],
        ['a Novita key', 'Invalid API key provided: sk_Zk3V8mQ2xR7tY1nB5cL9wQ'],
        ['an xAI key', 'Invalid API key provided: xai-Zk3V8mQ2xR7tY1nB5cL9wQ'],
        ['a Groq key', 'Invalid API key provided: gsk_Zk3V8mQ2xR7tY1nB5cL9wQ'],
        ['a Hugging Face key', 'Invalid API key provided: hf_Zk3V8mQ2xR7tY1nB5cL9wQ'],
        ['a Z.ai key', 'Invalid API key provided: 0123456789abcdef0123456789abcdef.Zk3V8mQ2xR7tY1nB'],
        ['a JWT', 'Invalid token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl'],
        ['a token= pair', 'Rejected: token=Zk3V8mQ2xR7tY1nB5cL9'],
        ['a password: pair', 'Rejected: password: hunter2hunter2'],
        ['an e-mail address', 'Account owner jane.doe@example.com has no credit'],
    ])('redacts %s', (_label, sentence) => {
        const secret = sentence.match(
            /(AQ\.\S+|ABSK\S+|fw_\S+|tgp_v1_\S+|sk_\S+|xai-\S+|gsk_\S+|hf_\S+|[0-9a-f]{32}\.\S+|eyJ\S+|Zk3V8mQ2xR7tY1nB5cL9|hunter2hunter2|jane\.doe@example\.com)/,
        )![0];
        const published = extractProviderMessage(apiError({ error: { message: sentence } }, 401)) ?? '';
        expect(published).not.toContain(secret);
        expect(published).toContain('[redacted]');
    });
});
