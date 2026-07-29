import { BYOKProvider } from '@kodus/kodus-common/llm';
import { BadRequestException } from '@nestjs/common';
import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import type { BYOKConfigV2 } from '@libs/llm/byok-config';
import { CreateOrUpdateOrganizationParametersUseCase } from './create-or-update.use-case';

const orgAndTeam = { organizationId: 'org-1', teamId: 'team-1' } as any;

/**
 * Build the use-case with a mocked parameters service. `existing` is what
 * findByKey returns as the stored configValue (undefined → no row). The
 * captured `persisted` holds whatever createOrUpdateConfig was asked to write.
 */
function buildUseCase(existing?: unknown) {
    const persisted: { value?: any } = {};
    const createOrUpdateConfig = jest.fn(async (_k, value: any) => {
        persisted.value = value;
        return true;
    });
    const organizationParametersService = {
        findByKey: jest
            .fn()
            .mockResolvedValue(
                existing === undefined ? null : { configValue: existing },
            ),
        createOrUpdateConfig,
    };
    const request = { user: { uuid: 'user-1', email: 'u@k.io' } } as any;
    const eventEmitter = { emit: jest.fn() } as any;
    const telemetry = { byokConfigured: jest.fn() } as any;

    const useCase = new CreateOrUpdateOrganizationParametersUseCase(
        organizationParametersService as any,
        request,
        eventEmitter,
        telemetry,
    );

    return { useCase, persisted, createOrUpdateConfig, organizationParametersService };
}

const saveByok = (useCase: CreateOrUpdateOrganizationParametersUseCase, configValue: unknown) =>
    useCase.execute(
        OrganizationParametersKey.BYOK_CONFIG,
        configValue as any,
        orgAndTeam,
    );

const v2 = (over: Partial<BYOKConfigV2> = {}): BYOKConfigV2 => ({
    version: 2,
    credentials: [{ id: 'cred-openai', provider: 'openai', apiKey: '' }],
    models: [{ id: 'model-a', credentialId: 'cred-openai', model: 'gpt-5' }],
    ...over,
});

describe('CreateOrUpdateOrganizationParametersUseCase — BYOK write path', () => {
    // ─────────────────────────────────────────────────────────────────────
    // Task 1: v2-aware encrypt/keep
    // ─────────────────────────────────────────────────────────────────────
    describe('v2 encrypt/keep (absorbed 02-05 / D-07)', () => {
        it('keeps the credential ciphertext on a BLANK apiKey resubmit (no key loss)', async () => {
            const priorCipher = encrypt('sk-real-openai-key');
            const existing = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: priorCipher },
                ],
            });
            const incoming = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: '' },
                ],
            });

            const { useCase, persisted, createOrUpdateConfig } =
                buildUseCase(existing);

            await saveByok(useCase, incoming);

            expect(createOrUpdateConfig).toHaveBeenCalled();
            // exact ciphertext kept verbatim — NOT re-encrypted
            expect(persisted.value.credentials[0].apiKey).toBe(priorCipher);
        });

        it('encrypts a real non-empty apiKey (decrypts back to the submitted key)', async () => {
            const existing = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: encrypt('old') },
                ],
            });
            const incoming = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: 'sk-brand-new' },
                ],
            });

            const { useCase, persisted } = buildUseCase(existing);
            await saveByok(useCase, incoming);

            const stored = persisted.value.credentials[0].apiKey;
            expect(stored).not.toBe('sk-brand-new'); // stored as ciphertext
            expect(decrypt(stored)).toBe('sk-brand-new');
        });

        it('NEVER encrypts the •••• mask — keeps the prior ciphertext instead', async () => {
            const priorCipher = encrypt('sk-real-openai-key');
            const existing = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: priorCipher },
                ],
            });
            const incoming = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: 'sk01••••ab89' },
                ],
            });

            const { useCase, persisted } = buildUseCase(existing);
            await saveByok(useCase, incoming);

            expect(persisted.value.credentials[0].apiKey).toBe(priorCipher);
            // the mask literal never became ciphertext
            expect(persisted.value.credentials[0].apiKey).not.toContain('•');
        });

        it('matches the prior credential by provider when the id differs', async () => {
            const priorCipher = encrypt('sk-real-openai-key');
            const existing = v2({
                credentials: [
                    { id: 'cred-old-id', provider: 'openai', apiKey: priorCipher },
                ],
            });
            const incoming = v2({
                credentials: [
                    { id: 'cred-new-id', provider: 'openai', apiKey: '' },
                ],
                models: [
                    { id: 'model-a', credentialId: 'cred-new-id', model: 'gpt-5' },
                ],
            });

            const { useCase, persisted } = buildUseCase(existing);
            await saveByok(useCase, incoming);

            expect(persisted.value.credentials[0].apiKey).toBe(priorCipher);
        });

        it('keeps Bedrock aws* secrets (in settings) on a blank resubmit', async () => {
            const bearerCipher = encrypt('ABSK-bearer-token');
            const existing = v2({
                credentials: [
                    {
                        id: 'cred-bedrock',
                        provider: BYOKProvider.AMAZON_BEDROCK,
                        settings: {
                            awsBearerToken: bearerCipher,
                            awsRegion: 'us-east-1',
                        },
                    },
                ],
                models: [
                    { id: 'model-b', credentialId: 'cred-bedrock', model: 'claude' },
                ],
            });
            const incoming = v2({
                credentials: [
                    {
                        id: 'cred-bedrock',
                        provider: BYOKProvider.AMAZON_BEDROCK,
                        settings: { awsBearerToken: '', awsRegion: 'us-east-1' },
                    },
                ],
                models: [
                    { id: 'model-b', credentialId: 'cred-bedrock', model: 'claude' },
                ],
            });

            const { useCase, persisted } = buildUseCase(existing);
            await saveByok(useCase, incoming);

            const cred = persisted.value.credentials[0];
            expect(cred.settings.awsBearerToken).toBe(bearerCipher); // kept
            expect(cred.settings.awsRegion).toBe('us-east-1'); // non-secret verbatim
        });

        it('does NOT throw on a v2 blob with no top-level main/fallback', async () => {
            const { useCase } = buildUseCase(undefined);
            await expect(saveByok(useCase, v2())).resolves.toBe(true);
        });

        it('persists models/routing/version verbatim (field-level encrypt only)', async () => {
            const incoming = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: 'sk-x' },
                ],
                models: [
                    { id: 'model-a', credentialId: 'cred-openai', model: 'gpt-5' },
                ],
                routing: { mode: 'manual', defaultModelId: 'model-a' },
            });
            const { useCase, persisted } = buildUseCase(undefined);
            await saveByok(useCase, incoming);

            expect(persisted.value.version).toBe(2);
            expect(persisted.value.models).toEqual(incoming.models);
            expect(persisted.value.routing).toEqual(incoming.routing);
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Task 1: legacy path unchanged (byte-identical)
    // ─────────────────────────────────────────────────────────────────────
    describe('legacy {main,fallback} path is byte-identical', () => {
        it('encrypts a new main.apiKey (decrypts back to the submitted key)', async () => {
            const incoming = {
                main: {
                    provider: BYOKProvider.OPENAI,
                    apiKey: 'sk-legacy-new',
                    model: 'gpt-5',
                },
            };
            const { useCase, persisted } = buildUseCase(undefined);
            await saveByok(useCase, incoming);

            expect(decrypt(persisted.value.main.apiKey)).toBe('sk-legacy-new');
            expect(persisted.value.main.provider).toBe(BYOKProvider.OPENAI);
            expect(persisted.value.main.model).toBe('gpt-5');
        });

        it('keeps existing main ciphertext on a blank apiKey, updates the model', async () => {
            const priorCipher = encrypt('sk-legacy-old');
            const existing = {
                main: {
                    provider: BYOKProvider.OPENAI,
                    apiKey: priorCipher,
                    model: 'gpt-4',
                },
            };
            const incoming = {
                main: {
                    provider: BYOKProvider.OPENAI,
                    apiKey: '',
                    model: 'gpt-5',
                },
            };
            const { useCase, persisted } = buildUseCase(existing);
            await saveByok(useCase, incoming);

            expect(persisted.value.main.apiKey).toBe(priorCipher); // verbatim keep
            expect(persisted.value.main.model).toBe('gpt-5');
        });

        it('still throws when neither main nor fallback is present', async () => {
            const { useCase, createOrUpdateConfig } = buildUseCase(undefined);
            await expect(saveByok(useCase, {})).rejects.toThrow();
            expect(createOrUpdateConfig).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Task 2: write-time referential integrity (RFC §13.8)
    // ─────────────────────────────────────────────────────────────────────
    describe('write-time referential integrity for the v2 blob', () => {
        it('rejects a dangling model.credentialId BEFORE persist (400)', async () => {
            const incoming = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: 'sk-x' },
                ],
                models: [
                    { id: 'model-a', credentialId: 'cred-ghost', model: 'gpt-5' },
                ],
            });
            const { useCase, createOrUpdateConfig } = buildUseCase(undefined);

            await expect(saveByok(useCase, incoming)).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(createOrUpdateConfig).not.toHaveBeenCalled();
        });

        it('rejects a dangling routing ref BEFORE persist (400)', async () => {
            const incoming = v2({
                routing: { defaultModelId: 'model-missing' },
            });
            const { useCase, createOrUpdateConfig } = buildUseCase(undefined);

            await expect(saveByok(useCase, incoming)).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(createOrUpdateConfig).not.toHaveBeenCalled();
        });

        it('persists a consistent v2 config', async () => {
            const incoming = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: 'sk-x' },
                ],
                models: [
                    { id: 'model-a', credentialId: 'cred-openai', model: 'gpt-5' },
                ],
                routing: { defaultModelId: 'model-a' },
            });
            const { useCase, createOrUpdateConfig } = buildUseCase(undefined);

            await expect(saveByok(useCase, incoming)).resolves.toBe(true);
            expect(createOrUpdateConfig).toHaveBeenCalled();
        });

        it('does NOT gate a legacy write (validator is a no-op for non-v2)', async () => {
            const incoming = {
                main: {
                    provider: BYOKProvider.OPENAI,
                    apiKey: 'sk-legacy',
                    model: 'gpt-5',
                },
            };
            const { useCase, createOrUpdateConfig } = buildUseCase(undefined);

            await expect(saveByok(useCase, incoming)).resolves.toBe(true);
            expect(createOrUpdateConfig).toHaveBeenCalled();
        });
    });
});
