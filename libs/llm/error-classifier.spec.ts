import {
    LlmErrorCategory,
    attachClassification,
    classifyLLMError,
    getClassification,
    isTerminalCategory,
} from './error-classifier';
import {
    AgentContextWindowTooSmallError,
    AgentPromptTooLargeError,
} from './errors';

function errorWithStatus(message: string, status: number): Error {
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    return err;
}

describe('classifyLLMError', () => {
    it('does not throw on a malformed Error with a null message', () => {
        // Regression: "Cannot read properties of null (reading 'toLowerCase')".
        // err.message is typed string but can be null at runtime; the
        // rawMessage fallback must not blow up the whole error path.
        const err = new Error('x') as Error;
        (err as any).message = null;
        expect(() => classifyLLMError(err)).not.toThrow();
        expect(classifyLLMError(err).category).toBeDefined();
    });

    describe('HTTP status mapping (most reliable signal)', () => {
        it.each([401, 403])('maps %i → AUTH_INVALID', (status) => {
            const err = errorWithStatus('not authorized', status);
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.AUTH_INVALID,
            );
        });

        it('maps 402 → QUOTA_EXCEEDED', () => {
            const err = errorWithStatus('payment required', 402);
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.QUOTA_EXCEEDED,
            );
        });

        it('maps 404 → MODEL_NOT_FOUND', () => {
            const err = errorWithStatus('not found', 404);
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.MODEL_NOT_FOUND,
            );
        });

        it('reads the access-denied detail from responseBody when message is just "Not Found"', () => {
            // Mirrors @ai-sdk APICallError: terse message, detail in body.
            const err = Object.assign(new Error('Not Found'), {
                statusCode: 404,
                responseBody: JSON.stringify({
                    error: {
                        code: 404,
                        message:
                            'Publisher Model `.../publishers/anthropic/models/claude-sonnet-4-6` was not found or your project does not have access to it.',
                        status: 'NOT_FOUND',
                    },
                }),
            });
            expect(classifyLLMError(err, 'google_vertex').category).toBe(
                LlmErrorCategory.MODEL_ACCESS_DENIED,
            );
        });

        it('maps Vertex 404 "does not have access" → MODEL_ACCESS_DENIED with Model Garden guidance', () => {
            const err = errorWithStatus(
                'Publisher Model `projects/p/locations/global/publishers/anthropic/models/claude-sonnet-4-6` was not found or your project does not have access to it.',
                404,
            );
            const info = classifyLLMError(err, 'google_vertex');
            expect(info.category).toBe(
                LlmErrorCategory.MODEL_ACCESS_DENIED,
            );
            expect(info.friendlyMessage).toMatch(/Model Garden/i);
        });

        it('disambiguates 429 with quota-ish wording → QUOTA_EXCEEDED', () => {
            const err = errorWithStatus(
                'You exceeded your current quota, please check your plan and billing details.',
                429,
            );
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.QUOTA_EXCEEDED,
            );
        });

        it('treats plain 429 → RATE_LIMIT', () => {
            const err = errorWithStatus('too many requests', 429);
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.RATE_LIMIT,
            );
        });

        it.each([500, 502, 503, 504])('maps %i → TRANSIENT', (status) => {
            const err = errorWithStatus('upstream error', status);
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.TRANSIENT,
            );
        });

        it('reads status from nested response.status', () => {
            const err = Object.assign(new Error('boom'), {
                response: { status: 401 },
            });
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.AUTH_INVALID,
            );
        });

        it('reads status from cause chain', () => {
            const err = Object.assign(new Error('wrapped'), {
                cause: { statusCode: 429 },
            });
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.RATE_LIMIT,
            );
        });
    });

    describe('message-string fallback (no HTTP status)', () => {
        it('OpenAI insufficient_quota → QUOTA_EXCEEDED', () => {
            const err = new Error(
                'You exceeded your current quota. error code: insufficient_quota',
            );
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.QUOTA_EXCEEDED,
            );
        });

        it('Anthropic credit_balance_too_low → QUOTA_EXCEEDED', () => {
            const err = new Error(
                'Your credit balance is too low (code: credit_balance_too_low)',
            );
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.QUOTA_EXCEEDED,
            );
        });

        it('invalid_api_key → AUTH_INVALID', () => {
            const err = new Error('Error code: invalid_api_key');
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.AUTH_INVALID,
            );
        });

        it('permission_denied → AUTH_INVALID', () => {
            const err = new Error('permission_denied: cannot access resource');
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.AUTH_INVALID,
            );
        });

        it('rate limit phrasing → RATE_LIMIT', () => {
            const err = new Error('Rate limit reached, retry after 5s');
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.RATE_LIMIT,
            );
        });

        it('model_not_found → MODEL_NOT_FOUND', () => {
            const err = new Error(
                'The model `gpt-5-turbo` does not exist or you do not have access to it',
            );
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.MODEL_NOT_FOUND,
            );
        });

        it('context length errors → CONTEXT_OVERFLOW', () => {
            const err = new Error(
                'This model has a maximum context length of 128000 tokens',
            );
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.CONTEXT_OVERFLOW,
            );
        });

        it.each([
            'ECONNRESET',
            'ETIMEDOUT',
            'socket hang up',
            'fetch failed',
            'request aborted',
        ])('network/timeout pattern "%s" → TRANSIENT', (msg) => {
            const err = new Error(msg);
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.TRANSIENT,
            );
        });

        it('unrecognized message → UNKNOWN', () => {
            const err = new Error('something weird happened in the SDK');
            expect(classifyLLMError(err).category).toBe(
                LlmErrorCategory.UNKNOWN,
            );
        });

        it('non-Error inputs do not throw', () => {
            expect(classifyLLMError(null).category).toBe(
                LlmErrorCategory.UNKNOWN,
            );
            expect(classifyLLMError(undefined).category).toBe(
                LlmErrorCategory.UNKNOWN,
            );
            expect(classifyLLMError('plain string error').category).toBe(
                LlmErrorCategory.UNKNOWN,
            );
        });
    });

    describe('classification metadata', () => {
        it('echoes the provider when supplied', () => {
            const out = classifyLLMError(new Error('boom'), 'openai');
            expect(out.provider).toBe('openai');
        });

        it('renders a non-empty friendly message for every category', () => {
            for (const category of Object.values(LlmErrorCategory)) {
                const message = classifyLLMError(
                    Object.assign(new Error(`raw for ${category}`), {
                        status: 0,
                    }),
                ).friendlyMessage;
                expect(message.length).toBeGreaterThan(0);
            }
        });
    });

    describe('context-overflow friendly message — actionable variants', () => {
        it('AgentContextWindowTooSmallError surfaces the exact numbers and 3 options', () => {
            const err = new AgentContextWindowTooSmallError({
                contextWindow: 12_288,
                overheadTokens: 17_192,
                modelName: 'google_gemini:gemini-2.5-flash',
            });
            const msg = classifyLLMError(err).friendlyMessage;
            // The specific diagnosis with model and numbers.
            expect(msg).toContain('google_gemini:gemini-2.5-flash');
            expect(msg).toContain('12,288');
            expect(msg).toContain('17,192');
            // All three action options.
            expect(msg).toContain('Switch to a recommended model');
            expect(msg).toContain('Split the PR');
            expect(msg).toContain('byokConfig.main.maxInputTokens');
            // Names of curated models (the ones shown as cards in BYOK
            // settings — admins should recognize these).
            expect(msg).toContain('Claude Sonnet 4.6');
            expect(msg).toContain('Gemini 3.1 Pro');
        });

        it('AgentPromptTooLargeError surfaces the estimated prompt size', () => {
            const err = new AgentPromptTooLargeError({
                estimatedTokens: 71_110,
                contextWindowTokens: 12_288,
                modelName: 'llama-12k',
            });
            const msg = classifyLLMError(err).friendlyMessage;
            expect(msg).toContain('llama-12k');
            expect(msg).toContain('12,288');
            expect(msg).toContain('71,110');
            expect(msg).toContain('Switch to a recommended model');
        });

        it('raw provider context-overflow (no typed error) omits BYOK-limit option but keeps the others', () => {
            const err = new Error(
                'This model has a maximum context length of 128000 tokens',
            );
            const msg = classifyLLMError(err).friendlyMessage;
            // Diagnosis is generic (no specific numbers — we don't have them).
            expect(msg).toContain('exceeded the maximum context size');
            // Switch-model + split-PR options are present.
            expect(msg).toContain('Switch to a recommended model');
            expect(msg).toContain('Split the PR');
            // BYOK-limit option is omitted (no specific window to compare).
            expect(msg).not.toContain('byokConfig.main.maxInputTokens');
        });

        it('renders as GitHub-flavored Markdown (bold + bullets) so the PR comment formats correctly', () => {
            const err = new AgentContextWindowTooSmallError({
                contextWindow: 12_288,
                overheadTokens: 17_192,
                modelName: 'x',
            });
            const msg = classifyLLMError(err).friendlyMessage;
            expect(msg).toContain('**To resolve, choose one:**');
            expect(msg.split('\n').filter((l) => l.startsWith('- ')).length).toBe(3);
        });
    });
});

describe('isTerminalCategory', () => {
    it.each([
        LlmErrorCategory.AUTH_INVALID,
        LlmErrorCategory.QUOTA_EXCEEDED,
        LlmErrorCategory.MODEL_NOT_FOUND,
        LlmErrorCategory.MODEL_ACCESS_DENIED,
    ])('%s is terminal', (cat) => {
        expect(isTerminalCategory(cat)).toBe(true);
    });

    it.each([
        LlmErrorCategory.RATE_LIMIT,
        LlmErrorCategory.CONTEXT_OVERFLOW,
        LlmErrorCategory.TRANSIENT,
        LlmErrorCategory.UNKNOWN,
    ])('%s is not terminal', (cat) => {
        expect(isTerminalCategory(cat)).toBe(false);
    });
});

describe('attachClassification / getClassification', () => {
    it('round-trips classification info on an Error', () => {
        const err = new Error('boom');
        const info = classifyLLMError(
            errorWithStatus('out of credits', 402),
            'anthropic',
        );
        attachClassification(err, info);

        const retrieved = getClassification(err);
        expect(retrieved).toBeDefined();
        expect(retrieved?.category).toBe(LlmErrorCategory.QUOTA_EXCEEDED);
        expect(retrieved?.provider).toBe('anthropic');
    });

    it('returns undefined when no classification is attached', () => {
        expect(getClassification(new Error('untagged'))).toBeUndefined();
        expect(getClassification(null)).toBeUndefined();
        expect(getClassification('not an object')).toBeUndefined();
    });

    it('classification is not enumerable (does not leak into JSON.stringify)', () => {
        const err = new Error('boom');
        attachClassification(err, classifyLLMError(err, 'openai'));
        const serialized = JSON.stringify({
            message: err.message,
            ...Object.fromEntries(Object.entries(err)),
        });
        expect(serialized).not.toContain('AUTH_INVALID');
        expect(serialized).not.toContain('reviewErrorClassification');
    });
});
