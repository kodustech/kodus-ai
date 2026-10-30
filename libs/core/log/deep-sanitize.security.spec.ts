/**
 * deepSanitize secret-redaction conformance (BYOK v2 pre-merge SECURITY fix S1).
 *
 * The Pino redaction path normalizes a key with
 * `key.toLowerCase().replace(/[^a-z0-9]/g, '')` and matches it against a
 * SENSITIVE_KEYS set (exact match). Amazon Bedrock BYOK credentials travel
 * under aws* field names (awsSecretAccessKey / awsBearerToken /
 * awsAccessKeyId / awsSessionToken) that were NOT in the set, so a Bedrock
 * secret riding along on a logged object leaked in clear text at any depth.
 *
 * A failing assertion here is a REAL leak, NOT a test to relax.
 *
 * jest.setup.ts globally mocks '@libs/core/log/logger' (createLogger → no-op),
 * so we pull the REAL pure helpers via requireActual — importing them does not
 * spin up pino's worker transport (getPinoLogger is lazy).
 */
const { deepSanitize } = jest.requireActual('@libs/core/log/logger') as {
    deepSanitize: (obj: any) => any;
};

describe('deepSanitize — Bedrock AWS credential redaction (S1)', () => {
    const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

    it('redacts awsSecretAccessKey at the top level', () => {
        const out = deepSanitize({ awsSecretAccessKey: AWS_SECRET });
        expect(out.awsSecretAccessKey).toBe('[REDACTED]');
        expect(JSON.stringify(out)).not.toContain(AWS_SECRET);
    });

    it('redacts every Bedrock secret field name (any case / separators)', () => {
        const out = deepSanitize({
            awsSecretAccessKey: AWS_SECRET,
            awsBearerToken: 'ABSK-bearer-secret',
            awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            awsSessionToken: 'FQoGZXIvYXdzE-session-secret',
            aws_secret_access_key: AWS_SECRET, // snake_case normalizes the same
            'AWS-Bearer-Token': 'ABSK-bearer-secret', // header-style separators
        });

        for (const key of Object.keys(out)) {
            expect(out[key]).toBe('[REDACTED]');
        }
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain(AWS_SECRET);
        expect(serialized).not.toContain('ABSK-bearer-secret');
        expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(serialized).not.toContain('FQoGZXIvYXdzE-session-secret');
    });

    it('redacts a Bedrock secret nested deep inside a logged metadata object', () => {
        const out = deepSanitize({
            message: 'saving byok config',
            metadata: {
                configValue: {
                    credentials: [
                        {
                            provider: 'amazon_bedrock',
                            settings: {
                                awsSecretAccessKey: AWS_SECRET,
                                awsRegion: 'us-east-1',
                            },
                        },
                    ],
                },
            },
        });

        const settings =
            out.metadata.configValue.credentials[0].settings;
        expect(settings.awsSecretAccessKey).toBe('[REDACTED]');
        // Non-secret metadata still passes through.
        expect(settings.awsRegion).toBe('us-east-1');
        expect(JSON.stringify(out)).not.toContain(AWS_SECRET);
    });

    it('still redacts the pre-existing sensitive keys (no regression)', () => {
        const out = deepSanitize({
            apiKey: 'sk-openai-secret',
            password: 'hunter2',
            authorization: 'Bearer xyz',
        });
        expect(out.apiKey).toBe('[REDACTED]');
        expect(out.password).toBe('[REDACTED]');
        expect(out.authorization).toBe('[REDACTED]');
    });
});
