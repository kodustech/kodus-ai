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

        it('same key but DIFFERENT provider → TWO credentials (settings not lost)', () => {
            const shared = encrypt('sk-shared-key');
            const v2 = migrateLegacyToV2({
                main: legacySlot({ provider: 'openai', apiKey: shared }),
                // Same underlying key, reached through a compatible proxy — a
                // DISTINCT credential; folding it onto main would run the fallback
                // against api.openai.com instead of the proxy.
                fallback: legacySlot({
                    provider: 'openai_compatible',
                    apiKey: shared,
                    model: 'gpt-4o-mini',
                }),
            });

            expect(v2.credentials).toHaveLength(2);
            expect(v2.models).toHaveLength(2);
            expect(v2.credentials[1].provider).toBe('openai_compatible');
            expect(v2.models[1].credentialId).toBe(v2.credentials[1].id);
        });

        it('same key but DIFFERENT baseURL → TWO credentials (endpoint preserved)', () => {
            const shared = encrypt('sk-shared-key');
            const v2 = migrateLegacyToV2({
                main: legacySlot({ apiKey: shared }),
                fallback: legacySlot({
                    apiKey: shared,
                    model: 'gpt-4o-mini',
                    baseURL: 'https://proxy.example',
                }),
            });

            expect(v2.credentials).toHaveLength(2);
            expect(
                (v2.credentials[1].settings as Record<string, unknown>).baseURL,
            ).toBe('https://proxy.example');
        });

        it('same key AND same provider/settings → ONE credential (dedup still folds)', () => {
            const shared = encrypt('sk-shared-key');
            const v2 = migrateLegacyToV2({
                main: legacySlot({
                    apiKey: shared,
                    baseURL: 'https://proxy.example',
                }),
                fallback: legacySlot({
                    apiKey: shared,
                    model: 'gpt-4o-mini',
                    baseURL: 'https://proxy.example',
                }),
            });

            expect(v2.credentials).toHaveLength(1);
            expect(v2.models).toHaveLength(2);
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

    // Regression: shapes measured in the production BYOK export (416 legacy
    // rows). Before these fixes, 19 rows migrated to the empty/managed default
    // (losing their BYOK key) and 7 dropped their OpenRouter provider-pinning.
    describe('production edge cases', () => {
        // Amazon Bedrock authenticates with a bearer token (or access-key pair),
        // NOT an apiKey — the slot carries no apiKey at all.
        const bedrockSlot = (overrides: Record<string, unknown> = {}) => ({
            provider: 'amazon_bedrock',
            model: 'us.anthropic.claude-sonnet-4-6',
            awsBearerToken: encrypt('bedrock-bearer-token'),
            awsRegion: 'us-east-1',
            ...overrides,
        });

        it('migrates a Bedrock main (bearer token, NO apiKey) — never empties', () => {
            const main = bedrockSlot();
            const v2 = migrateLegacyToV2({ main });

            expect(v2.credentials).toHaveLength(1);
            expect(v2.models).toHaveLength(1);
            expect(v2.credentials[0].provider).toBe('amazon_bedrock');
            expect(v2.credentials[0].apiKey).toBeUndefined();
            // aws secret carried verbatim into settings (same ciphertext bytes).
            expect(v2.credentials[0].settings?.awsBearerToken).toBe(
                main.awsBearerToken,
            );
            expect(v2.credentials[0].settings?.awsRegion).toBe('us-east-1');
            expect(v2.routing?.defaultModelId).toBe(v2.models[0].id);
        });

        it('migrates a Bedrock main + Bedrock fallback to two credentials', () => {
            const v2 = migrateLegacyToV2({
                main: bedrockSlot(),
                fallback: bedrockSlot({
                    model: 'global.anthropic.claude-opus-4-7',
                    awsBearerToken: encrypt('bedrock-bearer-token-2'),
                }),
            });
            expect(v2.credentials).toHaveLength(2);
            expect(v2.models).toHaveLength(2);
        });

        it('accepts a Bedrock access-key pair as auth', () => {
            const v2 = migrateLegacyToV2({
                main: {
                    provider: 'amazon_bedrock',
                    model: 'us.anthropic.claude-sonnet-4-6',
                    awsAccessKeyId: encrypt('AKIA...'),
                    awsSecretAccessKey: encrypt('secret'),
                },
            });
            expect(v2.credentials).toHaveLength(1);
            expect(v2.models).toHaveLength(1);
        });

        it('PROMOTES a fallback-only config (no usable main) instead of emptying', () => {
            const fallback = legacySlot({
                provider: 'openai_compatible',
                apiKey: encrypt('sk-fallback-only'),
                model: 'minimax-m3',
            });
            const v2 = migrateLegacyToV2({ fallback });

            expect(v2.credentials).toHaveLength(1);
            expect(v2.models).toHaveLength(1);
            // The promoted fallback becomes the default model.
            expect(v2.routing?.defaultModelId).toBe(v2.models[0].id);
            expect(v2.credentials[0].provider).toBe('openai_compatible');
            expect(v2.credentials[0].apiKey).toBe(fallback.apiKey);
            expect(v2.models[0].model).toBe('minimax-m3');
        });

        it('promotes the fallback when the main slot is present but UNUSABLE', () => {
            const v2 = migrateLegacyToV2({
                main: { provider: 'openai', apiKey: encrypt('k') }, // no model → unusable
                fallback: legacySlot({ model: 'gpt-5.4' }),
            });
            expect(v2.credentials).toHaveLength(1);
            expect(v2.models[0].model).toBe('gpt-5.4');
        });

        it('still empties a config with NO usable slot (managed default)', () => {
            const v2 = migrateLegacyToV2({
                main: { provider: 'openai' }, // no key, no model
            });
            expect(v2.credentials).toHaveLength(0);
            expect(v2.models).toHaveLength(0);
        });

        it('carries OpenRouter provider-pinning into credential settings', () => {
            const v2 = migrateLegacyToV2({
                main: legacySlot({
                    provider: 'open_router',
                    apiKey: encrypt('sk-or'),
                    model: 'z-ai/glm-5.2',
                    openrouterProviderOrder: ['novita', 'z-ai'],
                    openrouterAllowFallbacks: false,
                }),
            });
            expect(v2.credentials[0].settings?.openrouterProviderOrder).toEqual([
                'novita',
                'z-ai',
            ]);
            expect(v2.credentials[0].settings?.openrouterAllowFallbacks).toBe(
                false,
            );
        });

        it('does NOT dedup two OpenRouter slots that differ only in provider order', () => {
            const key = encrypt('sk-shared-or');
            const v2 = migrateLegacyToV2({
                main: legacySlot({
                    provider: 'open_router',
                    apiKey: key,
                    model: 'z-ai/glm-5.2',
                    openrouterProviderOrder: ['novita'],
                }),
                fallback: legacySlot({
                    provider: 'open_router',
                    apiKey: key,
                    model: 'z-ai/glm-5.2',
                    openrouterProviderOrder: ['z-ai'],
                }),
            });
            // Same key, but distinct routing → two credentials, both preserved.
            expect(v2.credentials).toHaveLength(2);
        });
    });

    // End-to-end: the whole point of migrating is that the READ path
    // (resolveDefaultSlot → the slot providers actually build from) resolves the
    // migrated blob correctly. Migrate, then resolve, then assert the slot.
    describe('post-migration read path (resolveDefaultSlot)', () => {
        it('resolves a migrated Bedrock config to a usable slot (no apiKey)', () => {
            const v2 = migrateLegacyToV2({
                main: {
                    provider: 'amazon_bedrock',
                    model: 'us.anthropic.claude-sonnet-4-6',
                    awsBearerToken: encrypt('bedrock-bearer'),
                    awsRegion: 'us-east-1',
                },
            });
            const slot = resolveDefaultSlot(v2);
            expect(slot).toBeDefined();
            expect(slot?.provider).toBe('amazon_bedrock');
            expect(slot?.model).toBe('us.anthropic.claude-sonnet-4-6');
            expect(slot?.apiKey).toBe(''); // aws-auth: empty apiKey, not undefined
            expect(slot?.awsBearerToken).toBeTruthy();
            expect(slot?.awsRegion).toBe('us-east-1');
        });

        it('resolves a migrated fallback-only config to the promoted slot', () => {
            const v2 = migrateLegacyToV2({
                fallback: legacySlot({
                    provider: 'openai_compatible',
                    apiKey: encrypt('sk-fb'),
                    model: 'minimax-m3',
                    baseURL: 'https://api.example.com/v1',
                }),
            });
            const slot = resolveDefaultSlot(v2);
            expect(slot).toBeDefined();
            expect(slot?.provider).toBe('openai_compatible');
            expect(slot?.model).toBe('minimax-m3');
            expect(slot?.baseURL).toBe('https://api.example.com/v1');
        });

        it('surfaces OpenRouter provider-pinning onto the resolved slot', () => {
            const v2 = migrateLegacyToV2({
                main: legacySlot({
                    provider: 'open_router',
                    apiKey: encrypt('sk-or'),
                    model: 'z-ai/glm-5.2',
                    openrouterProviderOrder: ['novita', 'z-ai'],
                    openrouterAllowFallbacks: false,
                }),
            });
            const slot = resolveDefaultSlot(v2);
            expect(slot?.openrouterProviderOrder).toEqual(['novita', 'z-ai']);
            expect(slot?.openrouterAllowFallbacks).toBe(false);
        });
    });

    // ── Mutation-hardening: pin every branch/boundary/literal the transform
    // depends on, so a plausible off-by-one, dropped-field, or flipped-operator
    // regression makes a test fail (not merely reduces coverage). ─────────────
    describe('mutation-hardening', () => {
        describe('hasAuth branches (apiKey OR bearer OR access-key PAIR)', () => {
            it('a lone awsAccessKeyId (no secret) is NOT auth → unusable (AND, not OR)', () => {
                const v2 = migrateLegacyToV2({
                    main: {
                        provider: 'amazon_bedrock',
                        model: 'm',
                        awsAccessKeyId: encrypt('AKIA'),
                    },
                });
                expect(v2.credentials).toHaveLength(0);
                expect(v2.models).toHaveLength(0);
            });

            it('a lone awsSecretAccessKey (no id) is NOT auth → unusable (AND, not OR)', () => {
                const v2 = migrateLegacyToV2({
                    main: {
                        provider: 'amazon_bedrock',
                        model: 'm',
                        awsSecretAccessKey: encrypt('secret'),
                    },
                });
                expect(v2.credentials).toHaveLength(0);
                expect(v2.models).toHaveLength(0);
            });

            it('a bearer token alone IS auth → usable', () => {
                const v2 = migrateLegacyToV2({
                    main: {
                        provider: 'amazon_bedrock',
                        model: 'm',
                        awsBearerToken: encrypt('bearer'),
                    },
                });
                expect(v2.credentials).toHaveLength(1);
            });
        });

        describe('STR() empty-string guard (length > 0)', () => {
            it('an empty-string provider counts as absent → slot unusable', () => {
                const v2 = migrateLegacyToV2({
                    main: legacySlot({ provider: '' }),
                });
                expect(v2.credentials).toHaveLength(0);
            });

            it('an empty-string model counts as absent → slot unusable', () => {
                const v2 = migrateLegacyToV2({ main: legacySlot({ model: '' }) });
                expect(v2.credentials).toHaveLength(0);
            });

            it('an empty-string apiKey counts as absent auth → slot unusable', () => {
                const v2 = migrateLegacyToV2({
                    main: { provider: 'openai', model: 'gpt-4o', apiKey: '' },
                });
                expect(v2.credentials).toHaveLength(0);
            });
        });

        describe('exact synthetic id literals', () => {
            it('pins cred-main / model-main / cred-fallback / model-fallback for two distinct slots', () => {
                const v2 = migrateLegacyToV2({
                    main: legacySlot({ apiKey: encrypt('key-a') }),
                    fallback: legacySlot({
                        apiKey: encrypt('key-b'),
                        model: 'gpt-4o-mini',
                    }),
                });
                expect(v2.credentials[0].id).toBe('cred-main');
                expect(v2.credentials[1].id).toBe('cred-fallback');
                expect(v2.models[0].id).toBe('model-main');
                expect(v2.models[0].credentialId).toBe('cred-main');
                expect(v2.models[1].id).toBe('model-fallback');
                expect(v2.models[1].credentialId).toBe('cred-fallback');
                expect(v2.routing?.defaultModelId).toBe('model-main');
            });

            it('a folded (deduped) fallback model keeps its own id but references cred-main', () => {
                const shared = encrypt('sk-shared-key');
                const v2 = migrateLegacyToV2({
                    main: legacySlot({ apiKey: shared }),
                    fallback: legacySlot({
                        apiKey: shared,
                        model: 'gpt-4o-mini',
                    }),
                });
                expect(v2.credentials).toHaveLength(1);
                expect(v2.credentials[0].id).toBe('cred-main');
                expect(v2.models[1].id).toBe('model-fallback');
                expect(v2.models[1].credentialId).toBe('cred-main');
            });
        });

        describe('managedDefaultV2 exact shape', () => {
            it('empty result is exactly {version:2,credentials:[],models:[]} with NO routing', () => {
                const v2 = migrateLegacyToV2({});
                expect(v2).toEqual({ version: 2, credentials: [], models: [] });
                expect(v2.routing).toBeUndefined();
            });

            it('a non-object blob (string / number) → managed default', () => {
                expect(migrateLegacyToV2('nonsense')).toEqual({
                    version: 2,
                    credentials: [],
                    models: [],
                });
                expect(migrateLegacyToV2(42)).toEqual({
                    version: 2,
                    credentials: [],
                    models: [],
                });
            });
        });

        describe('credentialFromSlot settings presence', () => {
            it('omits `settings` entirely when the slot carries no setting fields', () => {
                const v2 = migrateLegacyToV2({ main: legacySlot() });
                expect(v2.credentials[0].settings).toBeUndefined();
            });

            it('attaches only the present non-secret settings', () => {
                const v2 = migrateLegacyToV2({
                    main: legacySlot({ baseURL: 'https://x.example' }),
                });
                expect(v2.credentials[0].settings).toEqual({
                    baseURL: 'https://x.example',
                });
            });
        });

        describe('modelFromSlot numeric fields use typeof number, not truthiness', () => {
            it('carries ZERO-valued numeric tuning fields', () => {
                const m = migrateLegacyToV2({
                    main: legacySlot({
                        temperature: 0,
                        maxInputTokens: 0,
                        maxOutputTokens: 0,
                        maxConcurrentRequests: 0,
                    }),
                }).models[0];
                expect(m.temperature).toBe(0);
                expect(m.maxInputTokens).toBe(0);
                expect(m.maxOutputTokens).toBe(0);
                expect(m.maxConcurrentRequests).toBe(0);
            });

            it('omits a non-number tuning field', () => {
                const m = migrateLegacyToV2({
                    main: legacySlot({ temperature: 'hot' }),
                }).models[0];
                expect(m.temperature).toBeUndefined();
            });

            it('omits tuning fields that are absent', () => {
                const m = migrateLegacyToV2({ main: legacySlot() }).models[0];
                expect(m.temperature).toBeUndefined();
                expect(m.maxInputTokens).toBeUndefined();
                expect(m.maxOutputTokens).toBeUndefined();
                expect(m.maxConcurrentRequests).toBeUndefined();
                expect(m.reasoningEffort).toBeUndefined();
                expect(m.reasoningConfigOverride).toBeUndefined();
            });

            it('carries reasoningConfigOverride but drops an empty-string override', () => {
                const withOverride = migrateLegacyToV2({
                    main: legacySlot({ reasoningConfigOverride: 'cfg' }),
                }).models[0];
                expect(withOverride.reasoningConfigOverride).toBe('cfg');

                const emptyOverride = migrateLegacyToV2({
                    main: legacySlot({ reasoningConfigOverride: '' }),
                }).models[0];
                expect(emptyOverride.reasoningConfigOverride).toBeUndefined();
            });
        });

        describe('sameCredential distinctness guards (each field matters)', () => {
            const shared = () => encrypt('sk-shared-key');

            it('different vertexLocation → distinct credentials', () => {
                const key = shared();
                const v2 = migrateLegacyToV2({
                    main: legacySlot({
                        apiKey: key,
                        vertexLocation: 'us-central1',
                    }),
                    fallback: legacySlot({
                        apiKey: key,
                        model: 'gpt-4o-mini',
                        vertexLocation: 'europe-west4',
                    }),
                });
                expect(v2.credentials).toHaveLength(2);
            });

            it('different awsRegion → distinct credentials', () => {
                const key = shared();
                const v2 = migrateLegacyToV2({
                    main: legacySlot({ apiKey: key, awsRegion: 'us-east-1' }),
                    fallback: legacySlot({
                        apiKey: key,
                        model: 'gpt-4o-mini',
                        awsRegion: 'us-west-2',
                    }),
                });
                expect(v2.credentials).toHaveLength(2);
            });

            it('secret present on ONLY one slot → distinct credentials', () => {
                const key = shared();
                const v2 = migrateLegacyToV2({
                    main: legacySlot({ apiKey: key }),
                    fallback: legacySlot({
                        apiKey: key,
                        model: 'gpt-4o-mini',
                        awsSessionToken: encrypt('sess'),
                    }),
                });
                expect(v2.credentials).toHaveLength(2);
            });

            it('secret ABSENT on both slots does not block dedup (continue branch)', () => {
                const key = shared();
                const v2 = migrateLegacyToV2({
                    main: legacySlot({ apiKey: key }),
                    fallback: legacySlot({ apiKey: key, model: 'gpt-4o-mini' }),
                });
                expect(v2.credentials).toHaveLength(1);
            });

            it('differing openrouterAllowFallbacks → distinct credentials', () => {
                const key = encrypt('sk-shared-or');
                const v2 = migrateLegacyToV2({
                    main: legacySlot({
                        provider: 'open_router',
                        apiKey: key,
                        model: 'z-ai/glm-5.2',
                        openrouterAllowFallbacks: true,
                    }),
                    fallback: legacySlot({
                        provider: 'open_router',
                        apiKey: key,
                        model: 'z-ai/glm-5.2',
                        openrouterAllowFallbacks: false,
                    }),
                });
                expect(v2.credentials).toHaveLength(2);
            });
        });

        describe('openrouter settings extraction from untrusted arrays/values', () => {
            it('drops openrouterProviderOrder when every entry is empty/non-string', () => {
                const v2 = migrateLegacyToV2({
                    main: legacySlot({
                        provider: 'open_router',
                        model: 'z-ai/glm-5.2',
                        openrouterProviderOrder: ['', 123, null],
                    }),
                });
                expect(
                    v2.credentials[0].settings?.openrouterProviderOrder,
                ).toBeUndefined();
            });

            it('filters non-string entries but keeps valid provider slugs in ORDER', () => {
                const v2 = migrateLegacyToV2({
                    main: legacySlot({
                        provider: 'open_router',
                        model: 'z-ai/glm-5.2',
                        openrouterProviderOrder: ['novita', '', 42, 'z-ai'],
                    }),
                });
                expect(
                    v2.credentials[0].settings?.openrouterProviderOrder,
                ).toEqual(['novita', 'z-ai']);
            });

            it('does not carry a non-boolean openrouterAllowFallbacks', () => {
                const v2 = migrateLegacyToV2({
                    main: legacySlot({
                        provider: 'open_router',
                        model: 'z-ai/glm-5.2',
                        openrouterAllowFallbacks: 'yes',
                    }),
                });
                expect(
                    v2.credentials[0].settings?.openrouterAllowFallbacks,
                ).toBeUndefined();
            });

            it('carries openrouterAllowFallbacks:true (boolean true is not dropped)', () => {
                const v2 = migrateLegacyToV2({
                    main: legacySlot({
                        provider: 'open_router',
                        model: 'z-ai/glm-5.2',
                        openrouterAllowFallbacks: true,
                    }),
                });
                expect(
                    v2.credentials[0].settings?.openrouterAllowFallbacks,
                ).toBe(true);
            });
        });

        describe('secondary emitted only when BOTH slots usable', () => {
            it('an unusable fallback is ignored when main is usable (no secondary)', () => {
                const v2 = migrateLegacyToV2({
                    main: legacySlot(),
                    fallback: { provider: 'openai' }, // no model/auth → unusable
                });
                expect(v2.credentials).toHaveLength(1);
                expect(v2.models).toHaveLength(1);
                expect(v2.models[0].id).toBe('model-main');
            });

            it('a promoted fallback-only config emits exactly one model with model-main id', () => {
                const v2 = migrateLegacyToV2({
                    fallback: legacySlot({ model: 'gpt-4o-mini' }),
                });
                expect(v2.models).toHaveLength(1);
                expect(v2.models[0].id).toBe('model-main');
                expect(v2.credentials[0].id).toBe('cred-main');
                expect(v2.routing?.defaultModelId).toBe('model-main');
            });
        });
    });
});
