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

    describe('legacy {main,fallback} mask dropped (04b-06 — v2-only)', () => {
        it('a legacy blob passes through unmasked (ciphertext, never plaintext)', async () => {
            const mainPlain = 'sk-legacy-main-key-1';
            const fbPlain = 'sk-legacy-fallback-2';
            const mainCipher = encrypt(mainPlain);
            const fbCipher = encrypt(fbPlain);
            const useCase = buildUseCase({
                main: {
                    provider: 'openai',
                    apiKey: mainCipher,
                    model: 'gpt-4o',
                },
                fallback: {
                    provider: 'anthropic',
                    apiKey: fbCipher,
                    model: 'claude-sonnet-4-5',
                },
            });

            const result = await useCase.execute(
                OrganizationParametersKey.BYOK_CONFIG,
                orgAndTeam,
            );

            // The legacy mask branch is gone: the blob is returned verbatim as
            // stored — ciphertext, NOT masked, and crucially NEVER plaintext.
            const cfg = result?.configValue as any;
            expect(cfg.main.apiKey).toBe(mainCipher);
            expect(cfg.fallback.apiKey).toBe(fbCipher);
            const serialized = JSON.stringify(cfg);
            expect(serialized).not.toContain(mainPlain);
            expect(serialized).not.toContain(fbPlain);
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

    // ─────────────────────────────────────────────────────────────────────
    // S2 (MEDIUM): a single undecryptable credential must NOT fail the whole
    // mask open. Before the fix, one throwing decrypt() bubbled to the execute
    // catch, which returned the RAW entity — dumping every credential's
    // ciphertext to the caller. The method must NEVER return unmasked ciphertext.
    // ─────────────────────────────────────────────────────────────────────
    describe('fail-closed masking (S2 — no raw ciphertext on a bad credential)', () => {
        it('degrades ONE undecryptable credential to a placeholder, still masks the rest', async () => {
            const goodPlain = 'sk-good-openai-key-777';
            const goodCipher = encrypt(goodPlain);
            const badCipher = 'not-real-ciphertext'; // decrypt() throws on this
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    { id: 'c-good', provider: 'openai', apiKey: goodCipher },
                    { id: 'c-bad', provider: 'anthropic', apiKey: badCipher },
                ],
                models: [],
            });

            const result = await useCase.execute(
                OrganizationParametersKey.BYOK_CONFIG,
                orgAndTeam,
            );

            const cfg = result?.configValue as any;
            const good = cfg.credentials.find((c: any) => c.id === 'c-good');
            const bad = cfg.credentials.find((c: any) => c.id === 'c-bad');

            // The good credential is masked normally.
            expect(good.apiKey).toBe(masked(goodPlain));
            // The bad credential degrades to a placeholder — NOT its raw ciphertext.
            expect(bad.apiKey).not.toBe(badCipher);
            expect(typeof bad.apiKey).toBe('string');

            // Crucially: nothing raw (good ciphertext, good plaintext, or the bad
            // ciphertext) reaches the caller.
            const serialized = JSON.stringify(cfg);
            expect(serialized).not.toContain(goodCipher);
            expect(serialized).not.toContain(goodPlain);
            expect(serialized).not.toContain(badCipher);
        });

        it('degrades a bad aws* secret under settings without exposing ciphertext', async () => {
            const badCipher = 'not-real-ciphertext';
            const useCase = buildUseCase({
                version: 2,
                credentials: [
                    {
                        id: 'c-bedrock',
                        provider: 'amazon_bedrock',
                        settings: {
                            awsSecretAccessKey: badCipher,
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
            expect(cred.settings.awsSecretAccessKey).not.toBe(badCipher);
            // Non-secret settings survive.
            expect(cred.settings.awsRegion).toBe('us-east-1');
            expect(JSON.stringify(result?.configValue)).not.toContain(badCipher);
        });
    });

    // ─────────────────────────────────────────────────────────────────────
    // S3 (LOW): maskApiKey used to `return apiKey` in full for a decrypted
    // value <= 6 chars — echoing a short/garbage key verbatim. A short value
    // must be masked too, never echoed.
    // ─────────────────────────────────────────────────────────────────────
    describe('short-key masking (S3 — never echo a full decrypted value)', () => {
        it('masks a short (<=6 char) decrypted key instead of echoing it', async () => {
            const shortPlain = 'abc'; // 3 chars — the old code returned this verbatim
            const cipher = encrypt(shortPlain);
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

            const cred = (result?.configValue as any).credentials[0];
            expect(cred.apiKey).not.toBe(shortPlain);
            expect(cred.apiKey).not.toBe(cipher);
            expect(JSON.stringify(result?.configValue)).not.toContain(cipher);
            // The short plaintext must not surface as a standalone echoed value.
            expect(cred.apiKey).not.toContain(shortPlain);
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
