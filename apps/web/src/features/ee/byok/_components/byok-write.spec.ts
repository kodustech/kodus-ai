import type { BYOKConfig, BYOKConnectInput } from '../_types';
import {
    buildByokBlob,
    credentialSettingsFromConfig,
    modelFieldsFromConfig,
} from './byok-write';

/**
 * The builder is pure and its ids must be deterministic under test — inject a
 * counter-based generator so we can assert exact ids without pulling in a real
 * uuid. Production defaults to crypto.randomUUID().
 */
const makeGenId = () => {
    let n = 0;
    return () => `id-${++n}`;
};

const MASK = 'sk-1•••••fabc'; // the shape maskKey() produces for a stored key

describe('buildByokBlob — v2 write builder (blank-key keep rule)', () => {
    describe('connect / first model (no existing config)', () => {
        it('creates one credential + one model and points routing.defaultModelId at it', () => {
            const blob = buildByokBlob(
                null,
                {
                    kind: 'connect',
                    newCredential: {
                        provider: 'openai',
                        apiKey: 'sk-real-openai-key',
                        settings: { baseURL: 'https://api.openai.com/v1' },
                    },
                    model: { model: 'gpt-5-high', reasoningEffort: 'high' },
                },
                makeGenId(),
            );

            expect(blob.version).toBe(2);
            expect(blob.credentials).toHaveLength(1);
            expect(blob.credentials[0]).toMatchObject({
                id: 'id-1',
                provider: 'openai',
                apiKey: 'sk-real-openai-key',
                settings: { baseURL: 'https://api.openai.com/v1' },
            });
            expect(blob.models).toHaveLength(1);
            expect(blob.models[0]).toMatchObject({
                id: 'id-2',
                credentialId: 'id-1',
                model: 'gpt-5-high',
                reasoningEffort: 'high',
            });
            // first-run default points at the just-created model
            expect(blob.routing?.defaultModelId).toBe('id-2');
        });

        it('sets the first-run default even when the existing config is managed-only (no visible model)', () => {
            const existing: BYOKConfig = {
                version: 2,
                credentials: [{ id: 'mgd', provider: 'openai', managed: true }],
                models: [],
                routing: {},
            };

            const blob = buildByokBlob(
                existing,
                {
                    kind: 'connect',
                    newCredential: {
                        provider: 'anthropic',
                        apiKey: 'sk-ant-real',
                    },
                    model: { model: 'claude-opus' },
                },
                makeGenId(),
            );

            const newModel = blob.models.find((m) => m.model === 'claude-opus');
            expect(newModel).toBeDefined();
            expect(blob.routing?.defaultModelId).toBe(newModel!.id);
        });
    });

    describe('add-model to an ALREADY-connected provider (reuse credential)', () => {
        const existing: BYOKConfig = {
            version: 2,
            credentials: [
                { id: 'cred-openai', provider: 'openai', apiKey: MASK },
            ],
            models: [
                { id: 'm-1', credentialId: 'cred-openai', model: 'gpt-5-high' },
            ],
            routing: { defaultModelId: 'm-1' },
        };

        it('appends only a models[] entry with the existing credentialId; credentials list is unchanged in shape', () => {
            const blob = buildByokBlob(
                existing,
                {
                    kind: 'add-existing-provider',
                    credentialId: 'cred-openai',
                    model: { model: 'gpt-5-mini', temperature: 0.2 },
                },
                makeGenId(),
            );

            expect(blob.credentials).toHaveLength(1);
            expect(blob.credentials[0].id).toBe('cred-openai');
            expect(blob.models).toHaveLength(2);
            const added = blob.models.find((m) => m.model === 'gpt-5-mini');
            expect(added).toMatchObject({
                credentialId: 'cred-openai',
                model: 'gpt-5-mini',
                temperature: 0.2,
            });
        });

        it('does NOT change routing.defaultModelId when a model already exists', () => {
            const blob = buildByokBlob(
                existing,
                {
                    kind: 'add-existing-provider',
                    credentialId: 'cred-openai',
                    model: { model: 'gpt-5-mini' },
                },
                makeGenId(),
            );
            expect(blob.routing?.defaultModelId).toBe('m-1');
        });

        it('NEVER re-emits the masked apiKey for the reused credential — it is blanked to keep the stored ciphertext', () => {
            const blob = buildByokBlob(
                existing,
                {
                    kind: 'add-existing-provider',
                    credentialId: 'cred-openai',
                    model: { model: 'gpt-5-mini' },
                },
                makeGenId(),
            );
            expect(blob.credentials[0].apiKey).toBe('');
            expect(blob.credentials[0].apiKey).not.toContain('•');
        });
    });

    describe('add-model for a NEW provider (new credential + key step)', () => {
        const existing: BYOKConfig = {
            version: 2,
            credentials: [
                { id: 'cred-openai', provider: 'openai', apiKey: MASK },
            ],
            models: [
                { id: 'm-1', credentialId: 'cred-openai', model: 'gpt-5-high' },
            ],
            routing: { defaultModelId: 'm-1' },
        };

        it('appends a new credential (with the pasted key) + a model referencing it, and blanks pre-existing credentials', () => {
            const blob = buildByokBlob(
                existing,
                {
                    kind: 'add-new-provider',
                    newCredential: {
                        provider: 'anthropic',
                        apiKey: 'sk-ant-fresh',
                    },
                    model: { model: 'claude-opus' },
                },
                makeGenId(),
            );

            expect(blob.credentials).toHaveLength(2);
            const oldCred = blob.credentials.find(
                (c) => c.id === 'cred-openai',
            );
            const newCred = blob.credentials.find(
                (c) => c.provider === 'anthropic',
            );
            expect(oldCred?.apiKey).toBe(''); // blanked, never the mask
            expect(newCred?.apiKey).toBe('sk-ant-fresh'); // the real pasted key
            const added = blob.models.find((m) => m.model === 'claude-opus');
            expect(added?.credentialId).toBe(newCred?.id);
            // still not first-run → default unchanged
            expect(blob.routing?.defaultModelId).toBe('m-1');
        });
    });

    describe('rotate key (blank keeps ciphertext, real value replaces it)', () => {
        const existing: BYOKConfig = {
            version: 2,
            credentials: [
                { id: 'cred-openai', provider: 'openai', apiKey: MASK },
            ],
            models: [
                { id: 'm-1', credentialId: 'cred-openai', model: 'gpt-5-high' },
            ],
            routing: { defaultModelId: 'm-1' },
        };

        it("sends apiKey: '' (NOT the •••• mask) when the key is unchanged", () => {
            const blob = buildByokBlob(
                existing,
                { kind: 'rotate', credentialId: 'cred-openai', apiKey: '' },
                makeGenId(),
            );
            const cred = blob.credentials.find((c) => c.id === 'cred-openai');
            expect(cred?.apiKey).toBe('');
            expect(cred?.apiKey).not.toContain('•');
        });

        it('sends the new key verbatim when the user typed one', () => {
            const blob = buildByokBlob(
                existing,
                {
                    kind: 'rotate',
                    credentialId: 'cred-openai',
                    apiKey: 'sk-rotated-new',
                },
                makeGenId(),
            );
            const cred = blob.credentials.find((c) => c.id === 'cred-openai');
            expect(cred?.apiKey).toBe('sk-rotated-new');
        });

        it('carries new provider settings (e.g. baseURL) when supplied on rotate', () => {
            const blob = buildByokBlob(
                existing,
                {
                    kind: 'rotate',
                    credentialId: 'cred-openai',
                    apiKey: '',
                    settings: { baseURL: 'https://proxy.internal/v1' },
                },
                makeGenId(),
            );
            const cred = blob.credentials.find((c) => c.id === 'cred-openai');
            expect(cred?.settings).toEqual({
                baseURL: 'https://proxy.internal/v1',
            });
        });

        it('does not add or remove models on rotate', () => {
            const blob = buildByokBlob(
                existing,
                { kind: 'rotate', credentialId: 'cred-openai', apiKey: '' },
                makeGenId(),
            );
            expect(blob.models).toHaveLength(1);
            expect(blob.models[0].id).toBe('m-1');
        });
    });

    describe('edit-model (preserve id, replace fields)', () => {
        const existing: BYOKConfig = {
            version: 2,
            credentials: [
                { id: 'cred-openai', provider: 'openai', apiKey: MASK },
            ],
            models: [
                {
                    id: 'm-1',
                    credentialId: 'cred-openai',
                    model: 'gpt-5-high',
                    temperature: 0.2,
                },
            ],
            routing: { defaultModelId: 'm-1' },
        };

        it('preserves the existing model id and credentialId while replacing its config fields', () => {
            const blob = buildByokBlob(
                existing,
                {
                    kind: 'edit-model',
                    modelId: 'm-1',
                    model: {
                        model: 'gpt-5-high',
                        temperature: 0.7,
                        reasoningEffort: 'medium',
                        rpm: 60,
                    },
                },
                makeGenId(),
            );
            expect(blob.models).toHaveLength(1);
            expect(blob.models[0]).toMatchObject({
                id: 'm-1',
                credentialId: 'cred-openai',
                model: 'gpt-5-high',
                temperature: 0.7,
                reasoningEffort: 'medium',
                rpm: 60,
            });
        });

        it('blanks every existing credential key on edit-model (mask never emitted)', () => {
            const blob = buildByokBlob(
                existing,
                {
                    kind: 'edit-model',
                    modelId: 'm-1',
                    model: { model: 'gpt-5-high', temperature: 0.7 },
                },
                makeGenId(),
            );
            expect(blob.credentials[0].apiKey).toBe('');
        });
    });

    describe('secret hygiene invariant (across every flow)', () => {
        const existing: BYOKConfig = {
            version: 2,
            credentials: [
                { id: 'cred-openai', provider: 'openai', apiKey: MASK },
                { id: 'cred-anthropic', provider: 'anthropic', apiKey: MASK },
            ],
            models: [
                { id: 'm-1', credentialId: 'cred-openai', model: 'gpt-5-high' },
                {
                    id: 'm-2',
                    credentialId: 'cred-anthropic',
                    model: 'claude-opus',
                },
            ],
            routing: { defaultModelId: 'm-1' },
        };

        const flows = [
            {
                name: 'add-existing-provider',
                edit: {
                    kind: 'add-existing-provider' as const,
                    credentialId: 'cred-openai',
                    model: { model: 'gpt-5-mini' },
                },
            },
            {
                name: 'add-new-provider',
                edit: {
                    kind: 'add-new-provider' as const,
                    newCredential: { provider: 'novita', apiKey: 'sk-novita' },
                    model: { model: 'some-model' },
                },
            },
            {
                name: 'rotate',
                edit: {
                    kind: 'rotate' as const,
                    credentialId: 'cred-openai',
                    apiKey: '',
                },
            },
            {
                name: 'edit-model',
                edit: {
                    kind: 'edit-model' as const,
                    modelId: 'm-1',
                    model: { model: 'gpt-5-high', temperature: 0.5 },
                },
            },
        ];

        it.each(flows)(
            "never emits a masked ('•') string as any credential apiKey — $name",
            ({ edit }) => {
                const blob = buildByokBlob(existing, edit, makeGenId());
                for (const cred of blob.credentials) {
                    expect(cred.apiKey ?? '').not.toContain('•');
                }
            },
        );
    });

    describe('routing save + reset-to-default (Routing tab)', () => {
        const existing: BYOKConfig = {
            version: 2,
            credentials: [
                { id: 'cred-openai', provider: 'openai', apiKey: MASK },
                { id: 'cred-anthropic', provider: 'anthropic', apiKey: MASK },
            ],
            models: [
                { id: 'm-1', credentialId: 'cred-openai', model: 'gpt-5-high' },
                {
                    id: 'm-2',
                    credentialId: 'cred-anthropic',
                    model: 'claude-opus',
                },
            ],
            routing: {
                mode: 'manual',
                defaultModelId: 'm-1',
                fallbackModelId: 'm-2',
                taskOverrides: { prSummary: 'm-2' },
            },
        };

        it('replaces routing wholesale while preserving credentials + models (keys blanked)', () => {
            const blob = buildByokBlob(existing, {
                kind: 'routing',
                routing: {
                    mode: 'manual',
                    defaultModelId: 'm-2',
                    taskOverrides: { codeReview: 'm-1' },
                },
            });

            expect(blob.routing).toEqual({
                mode: 'manual',
                defaultModelId: 'm-2',
                taskOverrides: { codeReview: 'm-1' },
            });
            // Models untouched; credential keys blanked (never the •••• mask).
            expect(blob.models).toEqual(existing.models);
            for (const cred of blob.credentials) {
                expect(cred.apiKey ?? '').not.toContain('•');
            }
        });

        it('reset agents to default: KEEPS the default, clears fallback + every per-agent override, keeps providers + models', () => {
            // What the Routing tab saves after "Reset agents to default": the
            // default model stays (everything falls back to it), fallback + all
            // per-agent overrides are gone.
            const blob = buildByokBlob(existing, {
                kind: 'routing',
                routing: {
                    mode: 'manual',
                    defaultModelId: 'm-1',
                    taskOverrides: {},
                },
            });

            expect(blob.routing?.defaultModelId).toBe('m-1');
            expect(blob.routing?.fallbackModelId).toBeUndefined();
            expect(blob.routing?.taskOverrides).toEqual({});
            // The org's connected providers + models are NOT touched by a reset.
            expect(blob.credentials.map((c) => c.id)).toEqual([
                'cred-openai',
                'cred-anthropic',
            ]);
            expect(blob.models).toEqual(existing.models);
        });
    });
});

describe('credentialSettingsFromConfig — provider-scoped split', () => {
    /** A minimal legacy connect input with only the two required-ish fields set. */
    const base = (
        overrides: Partial<BYOKConnectInput> = {},
    ): BYOKConnectInput => ({
        model: 'gpt-5-high',
        apiKey: 'sk-real',
        provider: 'openai',
        ...overrides,
    });

    it('returns undefined when NO provider-scoped setting is present (empty→undefined boundary)', () => {
        // model/apiKey/provider are NOT credential settings, so nothing lands.
        expect(credentialSettingsFromConfig(base())).toBeUndefined();
    });

    it('returns a settings object (not undefined) as soon as ONE field is present', () => {
        expect(
            credentialSettingsFromConfig(base({ baseURL: 'https://x/v1' })),
        ).toEqual({ baseURL: 'https://x/v1' });
    });

    it('maps every provider-scoped field to its own key with the exact value', () => {
        const cfg = base({
            baseURL: 'https://proxy/v1',
            vertexLocation: 'us-central1',
            awsRegion: 'us-east-1',
            awsBearerToken: 'bearer-xyz',
            awsAccessKeyId: 'AKIA123',
            awsSecretAccessKey: 'secret-456',
            awsSessionToken: 'session-789',
            openrouterProviderOrder: ['fireworks', 'together'],
            openrouterAllowFallbacks: true,
        });
        expect(credentialSettingsFromConfig(cfg)).toEqual({
            baseURL: 'https://proxy/v1',
            vertexLocation: 'us-central1',
            awsRegion: 'us-east-1',
            awsBearerToken: 'bearer-xyz',
            awsAccessKeyId: 'AKIA123',
            awsSecretAccessKey: 'secret-456',
            awsSessionToken: 'session-789',
            openrouterProviderOrder: ['fireworks', 'together'],
            openrouterAllowFallbacks: true,
        });
    });

    it('does NOT leak the per-model / non-credential fields into settings', () => {
        const cfg = base({
            temperature: 0.5,
            maxInputTokens: 1000,
            reasoningEffort: 'high',
            baseURL: 'https://only/v1',
        });
        const settings = credentialSettingsFromConfig(cfg);
        // Only the provider-scoped field survives.
        expect(settings).toEqual({ baseURL: 'https://only/v1' });
        expect(settings).not.toHaveProperty('temperature');
        expect(settings).not.toHaveProperty('model');
        expect(settings).not.toHaveProperty('apiKey');
    });

    it('drops falsy string settings (empty baseURL is not included)', () => {
        // truthiness guard: "" must NOT create a baseURL key.
        expect(
            credentialSettingsFromConfig(base({ baseURL: '' })),
        ).toBeUndefined();
    });

    describe('openrouterAllowFallbacks — typeof boolean guard, NOT truthiness', () => {
        it('includes the value when it is `false` (false is a meaningful boolean)', () => {
            const settings = credentialSettingsFromConfig(
                base({ openrouterAllowFallbacks: false }),
            );
            // A naive `if (cfg.openrouterAllowFallbacks)` would drop this.
            expect(settings).toEqual({ openrouterAllowFallbacks: false });
        });

        it('includes the value when it is `true`', () => {
            expect(
                credentialSettingsFromConfig(
                    base({ openrouterAllowFallbacks: true }),
                ),
            ).toEqual({ openrouterAllowFallbacks: true });
        });

        it('excludes it when it is undefined', () => {
            const settings = credentialSettingsFromConfig(
                base({ openrouterAllowFallbacks: undefined }),
            );
            expect(settings).toBeUndefined();
        });

        it('excludes a non-boolean value (typeof guard rejects a string)', () => {
            const settings = credentialSettingsFromConfig(
                base({
                    openrouterAllowFallbacks: 'yes' as unknown as boolean,
                }),
            );
            expect(settings).toBeUndefined();
        });
    });
});

describe('modelFieldsFromConfig — per-model field lift', () => {
    it('lifts exactly the per-model fields, each from its matching config key', () => {
        // Distinct values per numeric field so a swapped mapping is caught.
        const cfg: BYOKConnectInput = {
            model: 'gpt-5-high',
            apiKey: 'sk-real',
            provider: 'openai',
            reasoningEffort: 'medium',
            reasoningConfigOverride: '{"budget_tokens":25000}',
            temperature: 0.42,
            maxInputTokens: 1111,
            maxOutputTokens: 2222,
            maxConcurrentRequests: 3,
            // credential-scoped noise that must NOT be lifted:
            baseURL: 'https://x/v1',
            awsRegion: 'us-east-1',
        };

        expect(modelFieldsFromConfig(cfg)).toEqual({
            model: 'gpt-5-high',
            reasoningEffort: 'medium',
            reasoningConfigOverride: '{"budget_tokens":25000}',
            temperature: 0.42,
            maxInputTokens: 1111,
            maxOutputTokens: 2222,
            maxConcurrentRequests: 3,
        });
    });

    it('does NOT carry credential-scoped fields onto the model', () => {
        const cfg: BYOKConnectInput = {
            model: 'm',
            apiKey: 'sk',
            provider: 'openai',
            baseURL: 'https://x/v1',
            awsRegion: 'us-east-1',
            openrouterAllowFallbacks: false,
        };
        const fields = modelFieldsFromConfig(cfg);
        expect(fields).not.toHaveProperty('baseURL');
        expect(fields).not.toHaveProperty('awsRegion');
        expect(fields).not.toHaveProperty('openrouterAllowFallbacks');
        expect(fields).not.toHaveProperty('apiKey');
        expect(fields).not.toHaveProperty('provider');
    });

    it('passes the model name through verbatim and leaves absent optionals undefined', () => {
        const fields = modelFieldsFromConfig({
            model: 'claude-opus',
            apiKey: 'sk',
            provider: 'anthropic',
        });
        expect(fields.model).toBe('claude-opus');
        expect(fields.temperature).toBeUndefined();
        expect(fields.reasoningEffort).toBeUndefined();
        expect(fields.maxOutputTokens).toBeUndefined();
    });

    it('preserves a numeric temperature of 0 (does not coerce it away)', () => {
        const fields = modelFieldsFromConfig({
            model: 'm',
            apiKey: 'sk',
            provider: 'openai',
            temperature: 0,
        });
        expect(fields.temperature).toBe(0);
    });
});

describe('buildByokBlob — keepCredential trim + managed boundaries', () => {
    const existing: BYOKConfig = {
        version: 2,
        credentials: [
            { id: 'cred-openai', provider: 'openai', apiKey: 'sk...def' },
            { id: 'cred-managed', provider: 'anthropic', managed: true },
        ],
        models: [
            { id: 'm-1', credentialId: 'cred-openai', model: 'gpt-5-high' },
        ],
        routing: { defaultModelId: 'm-1' },
    };

    it("treats a whitespace-only rotate key as 'keep' (blanks it, does not send the spaces)", () => {
        const blob = buildByokBlob(existing, {
            kind: 'rotate',
            credentialId: 'cred-openai',
            apiKey: '   ',
        });
        const cred = blob.credentials.find((c) => c.id === 'cred-openai');
        // trim() ⇒ empty ⇒ blank-to-keep, NOT the literal "   ".
        expect(cred?.apiKey).toBe('');
    });

    it('sends a real rotate key VERBATIM including its surrounding value (only the emptiness is trimmed)', () => {
        const blob = buildByokBlob(existing, {
            kind: 'rotate',
            credentialId: 'cred-openai',
            apiKey: ' sk-new-with-space ',
        });
        const cred = blob.credentials.find((c) => c.id === 'cred-openai');
        // trim() only decides keep-vs-replace; the emitted key is the raw value.
        expect(cred?.apiKey).toBe(' sk-new-with-space ');
    });

    it('passes a managed credential through untouched (no apiKey injected, managed flag kept)', () => {
        const blob = buildByokBlob(existing, {
            kind: 'edit-model',
            modelId: 'm-1',
            model: { model: 'gpt-5-high', temperature: 0.9 },
        });
        const managed = blob.credentials.find((c) => c.id === 'cred-managed');
        expect(managed).toEqual({
            id: 'cred-managed',
            provider: 'anthropic',
            managed: true,
        });
        expect(managed).not.toHaveProperty('apiKey');
    });

    it('a managed credential targeted by rotate is NOT given the pasted key', () => {
        const blob = buildByokBlob(existing, {
            kind: 'rotate',
            credentialId: 'cred-managed',
            apiKey: 'sk-should-be-ignored',
        });
        const managed = blob.credentials.find((c) => c.id === 'cred-managed');
        expect(managed).not.toHaveProperty('apiKey');
        expect(JSON.stringify(managed)).not.toContain('sk-should-be-ignored');
    });

    it('edit-model leaves NON-matching models byte-for-byte unchanged', () => {
        const twoModels: BYOKConfig = {
            ...existing,
            models: [
                { id: 'm-1', credentialId: 'cred-openai', model: 'gpt-5-high' },
                {
                    id: 'm-2',
                    credentialId: 'cred-openai',
                    model: 'gpt-5-mini',
                    temperature: 0.2,
                },
            ],
        };
        const blob = buildByokBlob(twoModels, {
            kind: 'edit-model',
            modelId: 'm-1',
            model: { model: 'gpt-5-high', temperature: 0.7 },
        });
        // m-2 is the untouched branch of the .map ternary.
        expect(blob.models.find((m) => m.id === 'm-2')).toEqual({
            id: 'm-2',
            credentialId: 'cred-openai',
            model: 'gpt-5-mini',
            temperature: 0.2,
        });
        // m-1 got its fields replaced.
        expect(blob.models.find((m) => m.id === 'm-1')?.temperature).toBe(0.7);
    });
});
