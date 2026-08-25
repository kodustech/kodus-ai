import { BYOKProvider } from '@libs/llm/model-providers';
import { BadRequestException } from '@nestjs/common';
import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import type { BYOKConfig } from '@libs/llm/byok-config';
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

const v2 = (over: Partial<BYOKConfig> = {}): BYOKConfig => ({
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

        it('does NOT throw on a config blob with no top-level main/fallback', async () => {
            const { useCase } = buildUseCase(undefined);
            // A first-save credential must carry a usable key (auth-path guard);
            // the point here is that the shape (no legacy main/fallback) is
            // accepted, not keyless leniency.
            await expect(
                saveByok(
                    useCase,
                    v2({
                        credentials: [
                            {
                                id: 'cred-openai',
                                provider: 'openai',
                                apiKey: 'sk-openai',
                            },
                        ],
                    }),
                ),
            ).resolves.toBe(true);
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
    // Task 1: legacy {main,fallback} write path dropped (04b-06 — v2-only)
    // ─────────────────────────────────────────────────────────────────────
    describe('legacy {main,fallback} write is rejected (v2-only)', () => {
        it('rejects a legacy {main} blob — encrypt expects the shape', async () => {
            const incoming = {
                main: {
                    provider: BYOKProvider.OPENAI,
                    apiKey: 'sk-legacy-new',
                    model: 'gpt-5',
                },
            };
            const { useCase, createOrUpdateConfig } = buildUseCase(undefined);

            await expect(saveByok(useCase, incoming)).rejects.toThrow();
            expect(createOrUpdateConfig).not.toHaveBeenCalled();
        });

        it('still throws on an empty {} blob', async () => {
            const { useCase, createOrUpdateConfig } = buildUseCase(undefined);
            await expect(saveByok(useCase, {})).rejects.toThrow();
            expect(createOrUpdateConfig).not.toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // Task 2: write-time referential integrity (RFC §13.8)
    // ─────────────────────────────────────────────────────────────────────
    describe('write-time referential integrity for the config blob', () => {
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

        it('persists a consistent config', async () => {
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

        it('rejects a legacy (non-v2) write outright (04b-06 — v2 is the only shape)', async () => {
            const incoming = {
                main: {
                    provider: BYOKProvider.OPENAI,
                    apiKey: 'sk-legacy',
                    model: 'gpt-5',
                },
            };
            const { useCase, createOrUpdateConfig } = buildUseCase(undefined);

            await expect(saveByok(useCase, incoming)).rejects.toThrow();
            expect(createOrUpdateConfig).not.toHaveBeenCalled();
        });
    });

    // SSRF: a credential's baseURL is a user-controlled outbound target the
    // server calls at review time. The save path must reject unsafe URLs, not
    // rely on the (client-triggered, skippable) test-connection probe.
    describe('SSRF guard on credential baseURL (save path)', () => {
        const withBaseURL = (baseURL: string): BYOKConfig =>
            v2({
                credentials: [
                    {
                        id: 'cred-oc',
                        provider: 'openai_compatible',
                        apiKey: 'sk-x',
                        settings: { baseURL },
                    },
                ],
                models: [
                    {
                        id: 'model-a',
                        credentialId: 'cred-oc',
                        model: 'gpt-5',
                    },
                ],
                routing: { defaultModelId: 'model-a' },
            });

        it('rejects a baseURL resolving to a private/reserved IP BEFORE persist (400)', async () => {
            const { useCase, createOrUpdateConfig } = buildUseCase(undefined);

            await expect(
                saveByok(useCase, withBaseURL('https://169.254.169.254/v1')),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(createOrUpdateConfig).not.toHaveBeenCalled();
        });

        it('rejects a non-https baseURL BEFORE persist (400)', async () => {
            const { useCase, createOrUpdateConfig } = buildUseCase(undefined);

            await expect(
                saveByok(useCase, withBaseURL('http://api.example.com/v1')),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(createOrUpdateConfig).not.toHaveBeenCalled();
        });

        it('allows a credential with no baseURL (key-only connect resolves the brand default)', async () => {
            const { useCase, createOrUpdateConfig } = buildUseCase(undefined);
            const noBaseURL = v2({
                credentials: [
                    { id: 'cred-oc', provider: 'openai_compatible', apiKey: 'sk-x' },
                ],
                models: [
                    { id: 'model-a', credentialId: 'cred-oc', model: 'gpt-5' },
                ],
                routing: { defaultModelId: 'model-a' },
            });

            await expect(saveByok(useCase, noBaseURL)).resolves.toBe(true);
            expect(createOrUpdateConfig).toHaveBeenCalled();
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // S4 (LOW, defense-in-depth): the SERVER display mask is `xx...yyy` (dots),
    // not the client `••••` bullet. isMaskedSecret only recognized the bullet,
    // so a round-tripped server mask would be RE-ENCRYPTED as if it were a real
    // key — silently destroying the stored credential. A server dotted mask must
    // be treated as "unchanged → keep the prior ciphertext".
    // ─────────────────────────────────────────────────────────────────────
    describe('server dotted-mask round-trip (S4 — keep ciphertext, never re-encrypt)', () => {
        it('keeps the prior ciphertext when the SERVER `xx...yyy` mask is resubmitted', async () => {
            const priorCipher = encrypt('sk-real-openai-key-abcdef');
            const existing = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: priorCipher },
                ],
            });
            // Shape emitted by find-by-key maskApiKey: first2 + '...' + last3.
            const incoming = v2({
                credentials: [
                    { id: 'cred-openai', provider: 'openai', apiKey: 'sk...def' },
                ],
            });

            const { useCase, persisted } = buildUseCase(existing);
            await saveByok(useCase, incoming);

            expect(persisted.value.credentials[0].apiKey).toBe(priorCipher);
            // the dotted mask literal never became ciphertext
            expect(persisted.value.credentials[0].apiKey).not.toContain('...');
        });

        it('keeps a Bedrock aws* secret when its server dotted mask is resubmitted', async () => {
            const bearerCipher = encrypt('ABSK-real-bearer-token-xyz');
            const existing = v2({
                credentials: [
                    {
                        id: 'cred-bedrock',
                        provider: BYOKProvider.AMAZON_BEDROCK,
                        settings: { awsBearerToken: bearerCipher, awsRegion: 'us-east-1' },
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
                        settings: { awsBearerToken: 'AB...xyz', awsRegion: 'us-east-1' },
                    },
                ],
                models: [
                    { id: 'model-b', credentialId: 'cred-bedrock', model: 'claude' },
                ],
            });

            const { useCase, persisted } = buildUseCase(existing);
            await saveByok(useCase, incoming);

            expect(persisted.value.credentials[0].settings.awsBearerToken).toBe(
                bearerCipher,
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // S1b (HIGH, defense-in-depth): the execute() error path logged the raw
    // `configValue` (the client's credential blob) in the error metadata. Even
    // with S1's key redaction, the raw blob must never be handed to the logger.
    // ─────────────────────────────────────────────────────────────────────
    describe('error logging never carries the raw configValue (S1b)', () => {
        it('logs only the key + org/team data, NOT configValue, when persist fails', async () => {
            const { useCase, organizationParametersService } =
                buildUseCase({ some: 'existing' });
            // Force the generic (non-BYOK) persist path to throw a plain Error.
            organizationParametersService.createOrUpdateConfig.mockRejectedValueOnce(
                new Error('db exploded'),
            );

            const secretBlob = { apiKey: 'sk-should-never-be-logged' };

            await expect(
                useCase.execute(
                    OrganizationParametersKey.TIMEZONE_CONFIG,
                    secretBlob as any,
                    orgAndTeam,
                ),
            ).rejects.toThrow();

            const errorSpy = (useCase as any).logger.error as jest.Mock;
            expect(errorSpy).toHaveBeenCalled();
            const logged = errorSpy.mock.calls[0][0];
            // configValue must be absent from the metadata …
            expect(logged.metadata).not.toHaveProperty('configValue');
            // … while the safe context is still logged.
            expect(logged.metadata.organizationParametersKey).toBe(
                OrganizationParametersKey.TIMEZONE_CONFIG,
            );
            expect(logged.metadata.organizationAndTeamData).toBe(orgAndTeam);
            // The secret never reaches the logger in any form.
            expect(JSON.stringify(logged.metadata)).not.toContain(
                'sk-should-never-be-logged',
            );
        });
    });
});
