import { resolveByokSlot } from './byok-credentials.util';

// Deterministic, reversible fake so the tests can assert on the *decrypted*
// value without holding a real key. `dec:<ciphertext>` marks plaintext.
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => `dec:${v}`,
}));

const org = { organizationId: 'org-1', teamId: 'team-1' } as any;

function buildService(configValue: unknown) {
    return {
        findByKey: jest
            .fn()
            .mockResolvedValue(
                configValue === undefined ? null : { configValue },
            ),
    } as any;
}

describe('resolveByokSlot', () => {
    describe('v2 shape (credentials[])', () => {
        it('resolves + decrypts a NON-managed credential for the provider', async () => {
            const service = buildService({
                version: 2,
                credentials: [
                    {
                        id: 'cred-1',
                        provider: 'openai_compatible',
                        apiKey: 'ENC_KEY',
                        settings: { baseURL: 'https://api.moonshot.ai/v1' },
                    },
                ],
                models: [],
            });

            const slot = await resolveByokSlot(
                service,
                'openai_compatible',
                org,
            );

            expect(slot).not.toBeNull();
            expect(slot?.provider).toBe('openai_compatible');
            // apiKey came back DECRYPTED (server-only path).
            expect(slot?.apiKey).toBe('dec:ENC_KEY');
            // baseURL is a plaintext setting, carried through verbatim.
            expect(slot?.baseURL).toBe('https://api.moonshot.ai/v1');
            // model is not part of a v2 credential — the caller supplies it.
            expect(slot?.model).toBeUndefined();
        });

        it('decrypts the aws* Bedrock secrets from settings', async () => {
            const service = buildService({
                version: 2,
                credentials: [
                    {
                        id: 'cred-bedrock',
                        provider: 'amazon_bedrock',
                        settings: {
                            awsBearerToken: 'ENC_BEARER',
                            awsAccessKeyId: 'ENC_AKID',
                            awsSecretAccessKey: 'ENC_SECRET',
                            awsSessionToken: 'ENC_SESSION',
                            awsRegion: 'us-east-1',
                        },
                    },
                ],
                models: [],
            });

            const slot = await resolveByokSlot(service, 'amazon_bedrock', org);

            expect(slot?.awsBearerToken).toBe('dec:ENC_BEARER');
            expect(slot?.awsAccessKeyId).toBe('dec:ENC_AKID');
            expect(slot?.awsSecretAccessKey).toBe('dec:ENC_SECRET');
            expect(slot?.awsSessionToken).toBe('dec:ENC_SESSION');
            // awsRegion is plaintext — NOT decrypted.
            expect(slot?.awsRegion).toBe('us-east-1');
        });

        it('returns null when only a MANAGED credential matches (never probed)', async () => {
            const service = buildService({
                version: 2,
                credentials: [
                    {
                        id: 'cred-managed',
                        provider: 'openai',
                        managed: true,
                    },
                ],
                models: [],
            });

            const slot = await resolveByokSlot(service, 'openai', org);

            expect(slot).toBeNull();
        });

        it('returns null when no v2 credential uses the provider', async () => {
            const service = buildService({
                version: 2,
                credentials: [
                    { id: 'cred-1', provider: 'anthropic', apiKey: 'ENC' },
                ],
                models: [],
            });

            const slot = await resolveByokSlot(service, 'openai', org);

            expect(slot).toBeNull();
        });
    });

    describe('legacy {main,fallback} slot lookup dropped (04b-06 — v2-only)', () => {
        it('returns null for a legacy main-slot blob (no longer read)', async () => {
            const service = buildService({
                main: {
                    provider: 'openai',
                    apiKey: 'ENC_MAIN',
                    baseURL: 'https://api.openai.com/v1',
                    model: 'gpt-4o',
                },
            });

            const slot = await resolveByokSlot(service, 'openai', org);

            expect(slot).toBeNull();
        });

        it('returns null for a legacy fallback-slot blob (no longer read)', async () => {
            const service = buildService({
                main: { provider: 'openai', apiKey: 'ENC_MAIN' },
                fallback: { provider: 'anthropic', apiKey: 'ENC_FB' },
            });

            const slot = await resolveByokSlot(service, 'anthropic', org);

            expect(slot).toBeNull();
        });
    });

    describe('no-op paths', () => {
        it('returns null with no org context', async () => {
            const service = buildService({
                main: { provider: 'openai', apiKey: 'ENC' },
            });

            const slot = await resolveByokSlot(service, 'openai', undefined);

            expect(slot).toBeNull();
            expect(service.findByKey).not.toHaveBeenCalled();
        });

        it('returns null when the org has no saved BYOK parameter', async () => {
            const service = buildService(undefined);

            const slot = await resolveByokSlot(service, 'openai', org);

            expect(slot).toBeNull();
        });
    });

    describe('secret hygiene', () => {
        it('never logs a decrypted value', async () => {
            const logSpies = [
                jest.spyOn(console, 'log').mockImplementation(() => {}),
                jest.spyOn(console, 'info').mockImplementation(() => {}),
                jest.spyOn(console, 'warn').mockImplementation(() => {}),
                jest.spyOn(console, 'error').mockImplementation(() => {}),
                jest.spyOn(console, 'debug').mockImplementation(() => {}),
            ];

            const service = buildService({
                version: 2,
                credentials: [
                    {
                        id: 'cred-1',
                        provider: 'openai_compatible',
                        apiKey: 'ENC_KEY',
                        settings: { awsSecretAccessKey: 'ENC_SECRET' },
                    },
                ],
                models: [],
            });

            const slot = await resolveByokSlot(
                service,
                'openai_compatible',
                org,
            );

            // Sanity: we DID decrypt.
            expect(slot?.apiKey).toBe('dec:ENC_KEY');

            const everyLogged = logSpies
                .flatMap((spy) => spy.mock.calls)
                .map((args) => JSON.stringify(args))
                .join('\n');

            expect(everyLogged).not.toContain('dec:ENC_KEY');
            expect(everyLogged).not.toContain('dec:ENC_SECRET');

            logSpies.forEach((spy) => spy.mockRestore());
        });
    });
});
