/**
 * Tests for the pure legacy→v2 BYOK transform (Phase 04b, plan 04b-07).
 *
 * The transform NEVER re-encrypts and NEVER logs a decrypted key — decryption
 * happens only in local scope for the dedup equality compare. These specs assert
 * that contract explicitly (ciphertext-verbatim bytes + a log spy that must see
 * no plaintext across every case).
 */
import { encrypt, decrypt } from '@libs/common/utils/crypto';
import { migrateLegacyToV2 } from './migrate-byok-config';
import { isByokConfig, type BYOKConfig } from './byok-config';
import { resolveDefaultSlot } from './resolve-model-slot';

// A minimal legacy `{main,fallback}` slot with the sensitive apiKey ENCRYPTED,
// mirroring how a real stored legacy blob looked.
function legacySlot(overrides: Record<string, unknown> = {}): {
    provider: string;
    apiKey: string;
    model: string;
    // The legacy slot also carries optional aws* / baseURL / tuning fields via
    // `overrides`; the index signature makes reading them back type-safe.
    [key: string]: unknown;
} {
    return {
        provider: 'openai',
        apiKey: encrypt('sk-main-plaintext-key'),
        model: 'gpt-4o',
        ...overrides,
    };
}

describe('migrateLegacyToV2', () => {
    describe('main-only legacy', () => {
        it('produces one credential + one model, ciphertext carried VERBATIM', () => {
            const main = legacySlot();
            const legacy = { main };

            const v2 = migrateLegacyToV2(legacy);

            expect(v2.version).toBe(2);
            expect(v2.credentials).toHaveLength(1);
            expect(v2.models).toHaveLength(1);
            // ciphertext bytes must be byte-identical (no re-encrypt).
            expect(v2.credentials[0].apiKey).toBe(main.apiKey);
            expect(v2.credentials[0].provider).toBe('openai');
            expect(v2.models[0].credentialId).toBe(v2.credentials[0].id);
            expect(v2.models[0].model).toBe('gpt-4o');
        });

        it('sets routing.defaultModelId to the FIRST (main) model id', () => {
            const v2 = migrateLegacyToV2({ main: legacySlot() });
            expect(v2.routing?.defaultModelId).toBe(v2.models[0].id);
        });

        it('carries model tuning fields onto the model', () => {
            const main = legacySlot({
                reasoningEffort: 'high',
                temperature: 0.3,
                maxInputTokens: 100,
                maxOutputTokens: 200,
                maxConcurrentRequests: 4,
            });
            const v2 = migrateLegacyToV2({ main });
            const m = v2.models[0];
            expect(m.reasoningEffort).toBe('high');
            expect(m.temperature).toBe(0.3);
            expect(m.maxInputTokens).toBe(100);
            expect(m.maxOutputTokens).toBe(200);
            expect(m.maxConcurrentRequests).toBe(4);
        });

        it('carries aws* / baseURL ciphertext + settings VERBATIM under settings', () => {
            const main = legacySlot({
                provider: 'aws_bedrock',
                baseURL: 'https://bedrock.example',
                awsRegion: 'us-east-1',
                awsAccessKeyId: encrypt('AKIA-plain'),
                awsSecretAccessKey: encrypt('secret-plain'),
            });
            const v2 = migrateLegacyToV2({ main });
            const s = v2.credentials[0].settings as Record<string, unknown>;
            expect(s.baseURL).toBe('https://bedrock.example');
            expect(s.awsRegion).toBe('us-east-1');
            // secret aws fields carried verbatim (no re-encrypt).
            expect(s.awsAccessKeyId).toBe(main.awsAccessKeyId);
            expect(s.awsSecretAccessKey).toBe(main.awsSecretAccessKey);
        });
    });

    describe('dedup by in-memory decrypt-compare', () => {
        it('main+fallback with the SAME key → ONE credential, TWO models', () => {
            const plaintext = 'sk-shared-key';
            // Random IV → DIFFERENT ciphertext for the same plaintext.
            const mainKey = encrypt(plaintext);
            const fallbackKey = encrypt(plaintext);
            expect(mainKey).not.toBe(fallbackKey); // sanity: ciphertext differs

            const v2 = migrateLegacyToV2({
                main: legacySlot({ apiKey: mainKey }),
                fallback: legacySlot({ apiKey: fallbackKey, model: 'gpt-4o-mini' }),
            });

            expect(v2.credentials).toHaveLength(1);
            expect(v2.models).toHaveLength(2);
            // Both models reference the single folded credential.
            expect(v2.models[0].credentialId).toBe(v2.credentials[0].id);
            expect(v2.models[1].credentialId).toBe(v2.credentials[0].id);
        });

        it('main+fallback with DIFFERENT keys → TWO credentials, TWO models', () => {
            const v2 = migrateLegacyToV2({
                main: legacySlot({ apiKey: encrypt('key-a') }),
                fallback: legacySlot({
                    apiKey: encrypt('key-b'),
                    model: 'gpt-4o-mini',
                }),
            });

            expect(v2.credentials).toHaveLength(2);
            expect(v2.models).toHaveLength(2);
            expect(v2.models[1].credentialId).toBe(v2.credentials[1].id);
            expect(v2.models[1].credentialId).not.toBe(v2.credentials[0].id);
        });

        it('degrades on decrypt() throw → treats slots as DISTINCT, never crashes (D-08)', () => {
            const garbage = 'not-a-valid-ciphertext';
            // sanity: this genuinely throws under the real crypto.
            expect(() => decrypt(garbage)).toThrow();

            const run = () =>
                migrateLegacyToV2({
                    main: legacySlot({ apiKey: garbage }),
                    fallback: legacySlot({ apiKey: garbage, model: 'gpt-4o-mini' }),
                });

            expect(run).not.toThrow();
            const v2 = run();
            expect(v2.credentials).toHaveLength(2);
            expect(v2.models).toHaveLength(2);
        });
    });

    describe('managed / env-default legacy', () => {
        it('legacy with no usable main → empty v2 (resolves to env/managed default)', () => {
            for (const blob of [
                undefined,
                null,
                {},
                { main: { provider: 'openai' } }, // no apiKey
                { main: { apiKey: encrypt('k'), model: 'm' } }, // no provider
            ]) {
                const v2 = migrateLegacyToV2(blob);
                expect(v2.version).toBe(2);
                expect(v2.credentials).toHaveLength(0);
                expect(v2.models).toHaveLength(0);
                // resolves to undefined (env/managed default) — no behavior change.
                expect(resolveDefaultSlot(v2)).toBeUndefined();
            }
        });
    });

    describe('idempotency', () => {
        it('already-config blob → returned UNCHANGED (value-idempotent)', () => {
            const v2: BYOKConfig = {
                version: 2,
                credentials: [{ id: 'c1', provider: 'openai', apiKey: 'ct' }],
                models: [{ id: 'm1', credentialId: 'c1', model: 'gpt-4o' }],
                routing: { defaultModelId: 'm1' },
            };
            expect(migrateLegacyToV2(v2)).toBe(v2);
        });

        it('running the transform TWICE yields the same result', () => {
            const legacy = { main: legacySlot() };
            const once = migrateLegacyToV2(legacy);
            const twice = migrateLegacyToV2(once);
            expect(twice).toEqual(once);
            expect(isByokConfig(twice)).toBe(true);
        });
    });

    describe('resolver round-trip (no behavior change on the resolved model)', () => {
        it('a migrated legacy blob normalizes to the SAME provider:model as legacy main', () => {
            const main = legacySlot({ provider: 'anthropic', model: 'claude-x' });
            const v2 = migrateLegacyToV2({ main });

            const slot = resolveDefaultSlot(v2);
            expect(slot?.provider).toBe('anthropic');
            expect(slot?.model).toBe('claude-x');
            // ciphertext preserved end-to-end (resolution never decrypts).
            expect(slot?.apiKey).toBe(main.apiKey);
        });
    });

    describe('secret hygiene — no plaintext ever logged', () => {
        it('emits NO decrypted key material to any console channel', () => {
            const plaintext = 'super-secret-plaintext-do-not-log';
            const spies = (
                ['log', 'info', 'warn', 'error', 'debug'] as const
            ).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));

            try {
                // Exercise the dedup decrypt path (same key both slots).
                migrateLegacyToV2({
                    main: legacySlot({ apiKey: encrypt(plaintext) }),
                    fallback: legacySlot({
                        apiKey: encrypt(plaintext),
                        model: 'gpt-4o-mini',
                    }),
                });

                for (const spy of spies) {
                    for (const call of spy.mock.calls) {
                        expect(JSON.stringify(call)).not.toContain(plaintext);
                    }
                }
            } finally {
                spies.forEach((s) => s.mockRestore());
            }
        });

        it('the returned config blob never contains the plaintext', () => {
            const plaintext = 'plaintext-must-not-leak-into-blob';
            const v2 = migrateLegacyToV2({
                main: legacySlot({ apiKey: encrypt(plaintext) }),
            });
            expect(JSON.stringify(v2)).not.toContain(plaintext);
        });
    });
});
