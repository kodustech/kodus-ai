import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';

import { FindByKeyOrganizationParametersUseCase } from './find-by-key.use-case';

const orgAndTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

function buildUseCase(configValue: unknown) {
    const parameter =
        configValue === undefined
            ? null
            : {
                  uuid: 'param-1',
                  configKey: OrganizationParametersKey.BYOK_CONFIG,
                  configValue,
                  organization: { uuid: 'org-1' },
              };
    const organizationParametersService = {
        findByKey: jest.fn().mockResolvedValue(parameter),
    };
    return new FindByKeyOrganizationParametersUseCase(
        organizationParametersService as any,
    );
}

/** maskApiKey contract: first 2 + '...' + last 3 chars of the PLAINTEXT. */
const masked = (plaintext: string) =>
    `${plaintext.slice(0, 2)}...${plaintext.slice(-3)}`;

describe('FindByKeyOrganizationParametersUseCase — BYOK masking', () => {
    describe('v2 shape (credentials[])', () => {
        it('masks credentials[].apiKey while leaving models/routing plaintext', async () => {
            const plaintext = 'sk-supersecret-key-123';
            const cipher = encrypt(plaintext);
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-1',
                        provider: 'openai',
                        apiKey: cipher,
                        settings: { baseURL: 'https://api.openai.com/v1' },
                    },
                ],
                models: [
                    { id: 'model-1', credentialId: 'cred-1', model: 'gpt-4o' },
                ],
                routing: { defaultModelId: 'model-1' },
            });

            const result = await useCase.execute(
                OrganizationParametersKey.BYOK_CONFIG,
                orgAndTeam,
            );

            const cfg = result?.configValue as any;
            expect(cfg.credentials[0].apiKey).toBe(masked(plaintext));
            // Neither the ciphertext nor the plaintext leaks.
            expect(cfg.credentials[0].apiKey).not.toBe(cipher);
            expect(cfg.credentials[0].apiKey).not.toContain(plaintext);
            // Non-secret settings + models + routing pass through plaintext.
            expect(cfg.credentials[0].settings.baseURL).toBe(
                'https://api.openai.com/v1',
            );
            expect(cfg.models).toEqual([
                { id: 'model-1', credentialId: 'cred-1', model: 'gpt-4o' },
            ]);
            expect(cfg.routing).toEqual({ defaultModelId: 'model-1' });
        });

        it('masks the aws* secrets under settings, leaving awsRegion plaintext', async () => {
            const secret = 'aws-secret-access-key-xyz';
            const cipher = encrypt(secret);
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-bedrock',
                        provider: 'amazon_bedrock',
                        settings: {
                            awsSecretAccessKey: cipher,
                            awsRegion: 'us-east-1',
                        },
                    },
                ],
                models: [],
            });

            const result = await useCase.execute(
                OrganizationParametersKey.BYOK_CONFIG,
                orgAndTeam,
            );

            const cred = (result?.configValue as any).credentials[0];
            expect(cred.settings.awsSecretAccessKey).toBe(masked(secret));
            expect(cred.settings.awsSecretAccessKey).not.toBe(cipher);
            expect(cred.settings.awsRegion).toBe('us-east-1');
        });

        it('never surfaces a managed credential secret', async () => {
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'cred-managed',
                        provider: 'openai',
                        managed: true,
                        // Defensive: even if a secret somehow rode along, it must
                        // never leave the server for a managed credential.
                        apiKey: encrypt('should-never-surface'),
                        settings: { awsBearerToken: encrypt('nope') },
                    },
                ],
                models: [],
            });

            const result = await useCase.execute(
                OrganizationParametersKey.BYOK_CONFIG,
                orgAndTeam,
            );

            const cred = (result?.configValue as any).credentials[0];
            expect(cred.apiKey).toBeUndefined();
            expect(cred.settings.awsBearerToken).toBeUndefined();
        });
    });

    describe('legacy {main,fallback} shape (regression — unchanged)', () => {
        it('masks main/fallback apiKey exactly as before', async () => {
            const mainPlain = 'sk-legacy-main-key-1';
            const fbPlain = 'sk-legacy-fallback-2';
            const useCase = buildUseCase({
                main: {
                    provider: 'openai',
                    apiKey: encrypt(mainPlain),
                    model: 'gpt-4o',
                },
                fallback: {
                    provider: 'anthropic',
                    apiKey: encrypt(fbPlain),
                    model: 'claude-sonnet-4-5',
                },
            });

            const result = await useCase.execute(
                OrganizationParametersKey.BYOK_CONFIG,
                orgAndTeam,
            );

            const cfg = result?.configValue as any;
            expect(cfg.main.apiKey).toBe(masked(mainPlain));
            expect(cfg.fallback.apiKey).toBe(masked(fbPlain));
            // Non-secret fields stay plaintext.
            expect(cfg.main.model).toBe('gpt-4o');
            expect(cfg.fallback.provider).toBe('anthropic');
        });

        it('passes a non-BYOK key through untouched', async () => {
            const useCase = buildUseCase({ timezone: 'UTC' });

            const result = await useCase.execute(
                OrganizationParametersKey.TIMEZONE_CONFIG,
                orgAndTeam,
            );

            expect(result?.configValue).toEqual({ timezone: 'UTC' });
        });
    });

    describe('secret hygiene', () => {
        it('never returns a ciphertext or plaintext key to the caller (v2)', async () => {
            const plaintext = 'sk-hygiene-check-9876';
            const cipher = encrypt(plaintext);
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    { id: 'c1', provider: 'openai', apiKey: cipher },
                ],
                models: [],
            });

            const result = await useCase.execute(
                OrganizationParametersKey.BYOK_CONFIG,
                orgAndTeam,
            );

            const serialized = JSON.stringify(result?.configValue);
            // Sanity: decrypt round-trips (proves the cipher was real).
            expect(decrypt(cipher)).toBe(plaintext);
            expect(serialized).not.toContain(cipher);
            expect(serialized).not.toContain(plaintext);
        });
    });
});
