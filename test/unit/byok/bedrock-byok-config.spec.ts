import { BYOKProvider } from '@kodus/kodus-common/llm';

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
 * pure encryption/validation logic on `encryptSlot`. We bypass the
 * private modifier with `as any` — this is the project convention for
 * testing private methods on services.
 */
function buildUseCase(): CreateOrUpdateOrganizationParametersUseCase {
    return new CreateOrUpdateOrganizationParametersUseCase(
        {} as any,
        {} as any,
        {} as any,
        { byokConfigured: jest.fn() } as any,
    );
}

describe('CreateOrUpdateOrganizationParametersUseCase — BYOK encryption', () => {
    const callSlot = (
        slot: 'main' | 'fallback',
        next: any,
        existing?: any,
    ) => (buildUseCase() as any).encryptSlot(slot, next, existing);

    describe('Amazon Bedrock', () => {
        it('encrypts the bearer token on first save', () => {
            const result = callSlot('main', {
                provider: BYOKProvider.AMAZON_BEDROCK,
                model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                awsBearerToken: 'ABSK-real-token',
                awsRegion: 'us-east-1',
            });

            expect(result.awsBearerToken).toBe('enc(ABSK-real-token)');
            expect(result.awsRegion).toBe('us-east-1');
            expect(result.awsAccessKeyId).toBeUndefined();
            expect(result.awsSecretAccessKey).toBeUndefined();
        });

        it('encrypts IAM credentials when bearer token is absent', () => {
            const result = callSlot('main', {
                provider: BYOKProvider.AMAZON_BEDROCK,
                model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                awsAccessKeyId: 'AKIA-id',
                awsSecretAccessKey: 'aws-secret',
                awsSessionToken: 'aws-session',
                awsRegion: 'us-east-1',
            });

            expect(result.awsAccessKeyId).toBe('enc(AKIA-id)');
            expect(result.awsSecretAccessKey).toBe('enc(aws-secret)');
            expect(result.awsSessionToken).toBe('enc(aws-session)');
            expect(result.awsBearerToken).toBeUndefined();
        });

        it('throws when no AWS auth path is provided on first save', () => {
            expect(() =>
                callSlot('main', {
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    awsRegion: 'us-east-1',
                }),
            ).toThrow(
                /Bedrock main BYOK config requires either awsBearerToken or awsAccessKeyId \+ awsSecretAccessKey/,
            );
        });

        it('throws when only the access key id is provided (missing secret)', () => {
            expect(() =>
                callSlot('main', {
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    awsAccessKeyId: 'AKIA-id',
                    awsRegion: 'us-east-1',
                }),
            ).toThrow(
                /Bedrock main BYOK config requires either awsBearerToken or awsAccessKeyId \+ awsSecretAccessKey/,
            );
        });

        it('keeps existing credentials when the user only edits non-secret fields', () => {
            const existing = {
                provider: BYOKProvider.AMAZON_BEDROCK,
                model: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
                awsBearerToken: 'enc(ABSK-stored)',
                awsRegion: 'us-east-1',
            };

            const result = callSlot(
                'main',
                {
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    awsRegion: 'us-east-1',
                },
                existing,
            );

            expect(result.awsBearerToken).toBe('enc(ABSK-stored)');
            expect(result.model).toBe(
                'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
            );
        });

        it('replaces only the field the user actually re-entered', () => {
            const existing = {
                provider: BYOKProvider.AMAZON_BEDROCK,
                model: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
                awsAccessKeyId: 'enc(AKIA-old)',
                awsSecretAccessKey: 'enc(secret-old)',
                awsRegion: 'us-east-1',
            };

            const result = callSlot(
                'main',
                {
                    provider: BYOKProvider.AMAZON_BEDROCK,
                    model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
                    awsAccessKeyId: 'AKIA-new',
                    awsRegion: 'us-east-1',
                },
                existing,
            );

            expect(result.awsAccessKeyId).toBe('enc(AKIA-new)');
            expect(result.awsSecretAccessKey).toBe('enc(secret-old)');
        });
    });

    describe('non-Bedrock providers (regression)', () => {
        it('still requires apiKey on first save', () => {
            expect(() =>
                callSlot('main', {
                    provider: BYOKProvider.ANTHROPIC,
                    model: 'claude-sonnet-4-5-20250929',
                }),
            ).toThrow(/apiKey is required for main BYOK config/);
        });

        it('encrypts the apiKey when provided', () => {
            const result = callSlot('main', {
                provider: BYOKProvider.ANTHROPIC,
                model: 'claude-sonnet-4-5-20250929',
                apiKey: 'sk-ant-real',
            });

            expect(result.apiKey).toBe('enc(sk-ant-real)');
        });

        it('keeps the existing apiKey on partial edit', () => {
            const result = callSlot(
                'main',
                {
                    provider: BYOKProvider.ANTHROPIC,
                    model: 'claude-sonnet-4-5-20250929',
                },
                {
                    provider: BYOKProvider.ANTHROPIC,
                    model: 'claude-3-5-sonnet-20241022',
                    apiKey: 'enc(sk-ant-stored)',
                },
            );

            expect(result.apiKey).toBe('enc(sk-ant-stored)');
        });
    });
});
