import { BYOKProvider } from '@libs/llm/model-providers';

// Encryption is irrelevant to the validation/fallback logic we want to
// pin down — we just need a deterministic, reversible stand-in so we can
// assert that encrypted fields were actually transformed (and that the
// fallback-to-existing path skipped encryption).
jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (value: string) => `enc(${value})`,
    decrypt: (value: string) => value.replace(/^enc\(|\)$/g, ''),
}));

import { CreateOrUpdateOrganizationParametersUseCase } from '@libs/organization/application/use-cases/organizationParameters/create-or-update.use-case';

/**
 * Constructs the use case with no-op dependencies so we can exercise the
 * pure v2 encrypt/validate logic on `encryptV2ByokConfig`. We bypass the
 * private modifier with `as any` — this is the project convention for
 * testing private methods on services.
 *
 * v2-native (04b-06): the legacy per-slot `encryptSlot({main,fallback})` is
 * GONE. Secrets now live on `credentials[]` — `apiKey` at the top level, the
 * Bedrock aws* auth under `settings` — and are encrypt/kept field-by-field.
 */
function buildUseCase(): CreateOrUpdateOrganizationParametersUseCase {
    return new CreateOrUpdateOrganizationParametersUseCase(
        {} as any,
        {} as any,
        {} as any,
        { byokConfigured: jest.fn() } as any,
    );
}

// Encrypt/validate a single incoming credential against an optional prior one,
// returning the resulting credential. Wraps each in a minimal v2 config so we
// exercise the real `encryptV2ByokConfig` path (credential matching by id +
// per-field encrypt/keep + auth-path validation).
const encryptCredential = (next: any, existing?: any) => {
    const cfg = (credential: any) => ({
        version: 2,
        credentials: [credential],
        models: [],
        routing: {},
    });
    return (buildUseCase() as any).encryptV2ByokConfig(
        cfg(next),
        existing ? cfg(existing) : undefined,
    ).credentials[0];
};

describe('CreateOrUpdateOrganizationParametersUseCase — v2 BYOK encryption', () => {
    describe('Amazon Bedrock', () => {
        it('encrypts the bearer token on first save', () => {
            const result = encryptCredential({
                id: 'c1',
                provider: BYOKProvider.AMAZON_BEDROCK,
                settings: {
                    awsBearerToken: 'ABSK-real-token',
                    awsRegion: 'us-east-1',
                },
            });

            expect(result.settings.awsBearerToken).toBe('enc(ABSK-real-token)');
            expect(result.settings.awsRegion).toBe('us-east-1');
            expect(result.settings.awsAccessKeyId).toBeUndefined();
            expect(result.settings.awsSecretAccessKey).toBeUndefined();
        });

        it('encrypts IAM credentials when bearer token is absent', () => {
            const result = encryptCredential({
                id: 'c1',
                provider: BYOKProvider.AMAZON_BEDROCK,
                settings: {
                    awsAccessKeyId: 'AKIA-id',
                    awsSecretAccessKey: 'aws-secret',
                    awsSessionToken: 'aws-session',
                    awsRegion: 'us-east-1',
                },
            });

            expect(result.settings.awsAccessKeyId).toBe('enc(AKIA-id)');
            expect(result.settings.awsSecretAccessKey).toBe('enc(aws-secret)');
            expect(result.settings.awsSessionToken).toBe('enc(aws-session)');
            expect(result.settings.awsBearerToken).toBeUndefined();
        });

        it('throws when no AWS auth path is provided on first save', () => {
            expect(() =>
                encryptCredential({
                    id: 'c1',
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    settings: { awsRegion: 'us-east-1' },
                }),
            ).toThrow(
                /Bedrock BYOK credential requires either awsBearerToken or awsAccessKeyId \+ awsSecretAccessKey/,
            );
        });

        it('throws when only the access key id is provided (missing secret)', () => {
            expect(() =>
                encryptCredential({
                    id: 'c1',
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    settings: {
                        awsAccessKeyId: 'AKIA-id',
                        awsRegion: 'us-east-1',
                    },
                }),
            ).toThrow(
                /Bedrock BYOK credential requires either awsBearerToken or awsAccessKeyId \+ awsSecretAccessKey/,
            );
        });

        it('keeps existing credentials when the user only edits non-secret fields', () => {
            const existing = {
                id: 'c1',
                provider: BYOKProvider.AMAZON_BEDROCK,
                settings: {
                    awsBearerToken: 'enc(ABSK-stored)',
                    awsRegion: 'us-east-1',
                },
            };

            const result = encryptCredential(
                {
                    id: 'c1',
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    settings: { awsRegion: 'eu-west-1' },
                },
                existing,
            );

            // Blank secret → prior ciphertext kept; the non-secret edit applies.
            expect(result.settings.awsBearerToken).toBe('enc(ABSK-stored)');
            expect(result.settings.awsRegion).toBe('eu-west-1');
        });

        it('replaces only the field the user actually re-entered', () => {
            const existing = {
                id: 'c1',
                provider: BYOKProvider.AMAZON_BEDROCK,
                settings: {
                    awsAccessKeyId: 'enc(AKIA-old)',
                    awsSecretAccessKey: 'enc(secret-old)',
                    awsRegion: 'us-east-1',
                },
            };

            const result = encryptCredential(
                {
                    id: 'c1',
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    settings: {
                        awsAccessKeyId: 'AKIA-new',
                        awsRegion: 'us-east-1',
                    },
                },
                existing,
            );

            expect(result.settings.awsAccessKeyId).toBe('enc(AKIA-new)');
            expect(result.settings.awsSecretAccessKey).toBe('enc(secret-old)');
        });
    });

    describe('non-Bedrock providers (regression)', () => {
        it('still requires apiKey on first save', () => {
            expect(() =>
                encryptCredential({
                    id: 'c1',
                    provider: BYOKProvider.ANTHROPIC,
                }),
            ).toThrow(/apiKey is required for the .* BYOK credential/);
        });

        it('encrypts the apiKey when provided', () => {
            const result = encryptCredential({
                id: 'c1',
                provider: BYOKProvider.ANTHROPIC,
                apiKey: 'sk-ant-real',
            });

            expect(result.apiKey).toBe('enc(sk-ant-real)');
        });

        it('keeps the existing apiKey on partial edit', () => {
            const result = encryptCredential(
                {
                    id: 'c1',
                    provider: BYOKProvider.ANTHROPIC,
                },
                {
                    id: 'c1',
                    provider: BYOKProvider.ANTHROPIC,
                    apiKey: 'enc(sk-ant-stored)',
                },
            );

            expect(result.apiKey).toBe('enc(sk-ant-stored)');
        });
    });
});
