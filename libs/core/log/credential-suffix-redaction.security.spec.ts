/**
 * Credentials that slipped through the exact-name list: field names used across
 * the codebase that end with a credential stem, and tokens with a known format
 * inside free text where no key name points at them.
 */
const { deepSanitize, sanitizeString } = jest.requireActual(
    '@libs/core/log/logger',
) as {
    deepSanitize: (obj: any) => any;
    sanitizeString: (value: string) => string;
};

describe('log redaction — credential names by suffix', () => {
    const leakedBefore = [
        'authToken',
        'gitHubToken',
        'sessionToken',
        'idToken',
        'id_token',
        'basicPassword',
        'newPassword',
        'personalApiKey',
        'projectApiKey',
        'webhookSecret',
        'cfAccessClientSecret',
        'clientPrivateKey',
        'GITHUB_TOKEN',
        'API_GITHUB_PRIVATE_KEY',
        'API_GITHUB_CLIENT_SECRET',
    ];

    it.each(leakedBefore)('redacts %s at any depth', (key) => {
        const out: any = deepSanitize({
            metadata: { authDetails: { [key]: 'value-1234' } },
        });

        expect(out.metadata.authDetails[key]).toBe('[REDACTED]');
    });

    it('keeps plural token counters and non-credential names visible', () => {
        const usage = {
            inputTokens: 10,
            outputTokens: 20,
            totalTokens: 30,
            maxTokens: 4096,
            hasToken: true,
            perToken: 0.000002,
            cancellationToken: 'cancel-id',
        };

        expect(deepSanitize({ usage })).toEqual({ usage });
    });

    it('redacts suffix-matched names inside strings too', () => {
        expect(sanitizeString('{"authToken":"value-1234"}')).toBe(
            '{"authToken":"[REDACTED]"}',
        );
    });
});

describe('log redaction — tokens with a known format in free text', () => {
    it.each([
        [
            'clone failed: token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
            'clone failed: token [REDACTED]',
        ],
        [
            'push rejected for github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
            'push rejected for [REDACTED]',
        ],
        [
            'GitLab said glpat-AbCdEfGhIjKlMnOpQrSt is invalid',
            'GitLab said [REDACTED] is invalid',
        ],
        [
            'request failed with Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
            'request failed with Bearer [REDACTED]',
        ],
    ])('%s', (input, expected) => {
        expect(sanitizeString(input)).toBe(expected);
    });

    it('leaves ordinary text alone', () => {
        const text = 'review finished in 12s, 3 suggestions, bearer of news';

        expect(sanitizeString(text)).toBe(text);
    });
});
