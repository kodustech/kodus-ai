import {
    isByokSlotConfigured,
    isV2ModelResolvable,
    describeLLMConfigStatus,
} from './llm-config-status';
import { BYOKProvider } from './model-providers';
import type { BYOKConfig, BYOKCredential } from './byok-config';

// Locks the two pure predicates at their kernel home (moved out of the org
// use-case). describeLLMConfigStatus is exercised end-to-end by
// get-llm-config-status.use-case.spec.ts.
describe('isByokSlotConfigured — provider-aware auth-material check', () => {
    it('most providers: configured iff an apiKey is present', () => {
        expect(isByokSlotConfigured({ provider: BYOKProvider.OPENAI, apiKey: 'k' })).toBe(true);
        expect(isByokSlotConfigured({ provider: BYOKProvider.OPENAI })).toBe(false);
    });

    it('Amazon Bedrock: bearer token OR static IAM pair, never apiKey', () => {
        expect(
            isByokSlotConfigured({
                provider: BYOKProvider.AMAZON_BEDROCK,
                awsBearerToken: 't',
            }),
        ).toBe(true);
        expect(
            isByokSlotConfigured({
                provider: BYOKProvider.AMAZON_BEDROCK,
                awsAccessKeyId: 'a',
                awsSecretAccessKey: 's',
            }),
        ).toBe(true);
        // apiKey alone is NOT enough for Bedrock
        expect(
            isByokSlotConfigured({
                provider: BYOKProvider.AMAZON_BEDROCK,
                apiKey: 'k',
            }),
        ).toBe(false);
    });

    it('null / undefined → false', () => {
        expect(isByokSlotConfigured(null)).toBe(false);
        expect(isByokSlotConfigured(undefined)).toBe(false);
    });
});

describe('isV2ModelResolvable — per-model resolvability', () => {
    const cred = (over: Partial<BYOKCredential> = {}): BYOKCredential =>
        ({ id: 'c1', provider: 'openai', apiKey: 'k', ...over }) as BYOKCredential;

    it('managed credential → resolves iff the env-default LLM is reachable', () => {
        const managed = cred({ managed: true, apiKey: undefined });
        expect(isV2ModelResolvable({ model: 'm', credentialId: 'c1' }, managed, true)).toBe(true);
        expect(isV2ModelResolvable({ model: 'm', credentialId: 'c1' }, managed, false)).toBe(false);
    });

    it('real BYOK credential → resolves iff provider + model + usable material', () => {
        expect(isV2ModelResolvable({ model: 'gpt-x', credentialId: 'c1' }, cred(), false)).toBe(true);
        // no apiKey → not resolvable
        expect(
            isV2ModelResolvable({ model: 'gpt-x', credentialId: 'c1' }, cred({ apiKey: undefined }), false),
        ).toBe(false);
        // no model name → not resolvable
        expect(isV2ModelResolvable({ model: '', credentialId: 'c1' }, cred(), false)).toBe(false);
    });

    it('missing model or credential → false', () => {
        expect(isV2ModelResolvable(null, cred(), true)).toBe(false);
        expect(isV2ModelResolvable({ model: 'm', credentialId: 'c1' }, null, true)).toBe(false);
    });
});

// ─── Mutation-killing additions (boundaries + literals) ──────────────────────

describe('isByokSlotConfigured — boundary + logic mutants', () => {
    it('empty-string apiKey is NOT configured (Boolean("") guard)', () => {
        expect(
            isByokSlotConfigured({ provider: BYOKProvider.OPENAI, apiKey: '' }),
        ).toBe(false);
    });

    it('Bedrock IAM pair requires BOTH keys (kills && → || mutant)', () => {
        // access key alone → not enough
        expect(
            isByokSlotConfigured({
                provider: BYOKProvider.AMAZON_BEDROCK,
                awsAccessKeyId: 'a',
            }),
        ).toBe(false);
        // secret key alone → not enough
        expect(
            isByokSlotConfigured({
                provider: BYOKProvider.AMAZON_BEDROCK,
                awsSecretAccessKey: 's',
            }),
        ).toBe(false);
        // both together → configured
        expect(
            isByokSlotConfigured({
                provider: BYOKProvider.AMAZON_BEDROCK,
                awsAccessKeyId: 'a',
                awsSecretAccessKey: 's',
            }),
        ).toBe(true);
    });

    it('Bedrock ignores apiKey but a non-Bedrock provider ignores aws* material', () => {
        // Bedrock: apiKey present, no aws material → false (branch is provider-gated)
        expect(
            isByokSlotConfigured({
                provider: BYOKProvider.AMAZON_BEDROCK,
                apiKey: 'k',
            }),
        ).toBe(false);
        // Non-Bedrock: aws material present, no apiKey → false (aws* not read here)
        expect(
            isByokSlotConfigured({
                provider: BYOKProvider.OPENAI,
                awsBearerToken: 't',
                awsAccessKeyId: 'a',
                awsSecretAccessKey: 's',
            }),
        ).toBe(false);
    });
});

describe('isV2ModelResolvable — provider/material reconstruction from settings', () => {
    const cred = (over: Partial<BYOKCredential> = {}): BYOKCredential =>
        ({ id: 'c1', provider: 'openai', apiKey: 'k', ...over }) as BYOKCredential;

    it('empty-string provider → not resolvable (asString guard)', () => {
        expect(
            isV2ModelResolvable(
                { model: 'gpt-x', credentialId: 'c1' },
                cred({ provider: '' }),
                false,
            ),
        ).toBe(false);
    });

    it('Bedrock credential resolves via settings.awsBearerToken (settings reconstruction)', () => {
        const bedrock = cred({
            provider: BYOKProvider.AMAZON_BEDROCK,
            apiKey: undefined,
            settings: { awsBearerToken: 'tok' },
        });
        expect(
            isV2ModelResolvable({ model: 'anthropic.claude', credentialId: 'c1' }, bedrock, false),
        ).toBe(true);
    });

    it('Bedrock credential resolves via settings IAM pair, but not a lone access key', () => {
        const pair = cred({
            provider: BYOKProvider.AMAZON_BEDROCK,
            apiKey: undefined,
            settings: { awsAccessKeyId: 'a', awsSecretAccessKey: 's' },
        });
        expect(
            isV2ModelResolvable({ model: 'm', credentialId: 'c1' }, pair, false),
        ).toBe(true);

        const loneAccess = cred({
            provider: BYOKProvider.AMAZON_BEDROCK,
            apiKey: undefined,
            settings: { awsAccessKeyId: 'a' },
        });
        expect(
            isV2ModelResolvable({ model: 'm', credentialId: 'c1' }, loneAccess, false),
        ).toBe(false);
    });

    it('managed short-circuits BEFORE provider/model checks (returns envReachable)', () => {
        // no provider, no model, no apiKey — but managed → follows envReachable only
        const managed = cred({
            managed: true,
            provider: '',
            apiKey: undefined,
        });
        expect(isV2ModelResolvable({ model: '', credentialId: 'c1' }, managed, true)).toBe(true);
        expect(isV2ModelResolvable({ model: '', credentialId: 'c1' }, managed, false)).toBe(false);
    });
});

describe('describeLLMConfigStatus — effective config projection', () => {
    // describeEnvLLMConfig() reads process.env directly, so control it per test.
    const ENV_KEYS = [
        'API_LLM_PROVIDER_MODEL',
        'API_OPEN_AI_API_KEY',
        'API_OPENAI_FORCE_BASE_URL',
        'API_VERTEX_AI_API_KEY',
        'API_GOOGLE_AI_API_KEY',
        'GOOGLE_GENERATIVE_AI_API_KEY',
        'API_VERTEX_AI_LOCATION',
        'API_LLM_TEMPERATURE_OVERRIDE',
        'GOOGLE_CLOUD_PROJECT',
        'GCLOUD_PROJECT',
    ] as const;

    let saved: Record<string, string | undefined>;

    beforeEach(() => {
        // Snapshot then clear every relevant var → env starts UNconfigured ('auto').
        saved = {};
        for (const k of ENV_KEYS) {
            saved[k] = process.env[k];
            delete process.env[k];
        }
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) {
                delete process.env[k];
            } else {
                process.env[k] = saved[k];
            }
        }
    });

    it('non-config blob with unconfigured env → source "none", empty models', () => {
        for (const blob of [undefined, null, {}, { version: 1 }]) {
            expect(describeLLMConfigStatus(blob)).toEqual({
                source: 'none',
                models: [],
                byok: { configured: false },
                env: { configured: false },
            });
        }
    });

    it('BYOK config → source "byok" with masked metadata + resolvable model', () => {
        const config: BYOKConfig = {
            version: 2,
            credentials: [
                {
                    id: 'cred-1',
                    provider: 'openai',
                    apiKey: 'enc-key',
                    settings: { baseURL: 'https://proxy.example/v1' },
                },
            ],
            models: [{ id: 'model-1', credentialId: 'cred-1', model: 'gpt-4o' }],
            routing: { defaultModelId: 'model-1' },
        };

        expect(describeLLMConfigStatus(config)).toEqual({
            source: 'byok',
            models: [
                {
                    modelId: 'model-1',
                    model: 'gpt-4o',
                    providerId: 'openai',
                    baseUrl: 'https://proxy.example/v1',
                    resolvable: true,
                    capabilities: {
                        structuredOutput: 'json_schema',
                        toolCalling: 'native',
                    },
                },
            ],
            byok: {
                configured: true,
                model: 'gpt-4o',
                providerId: 'openai',
                baseUrl: 'https://proxy.example/v1',
            },
            env: { configured: false },
        });
    });

    it('no BYOK slot + env configured → source "env", env fields surfaced, models []', () => {
        process.env.API_LLM_PROVIDER_MODEL = 'gpt-4o-mini';
        process.env.API_OPEN_AI_API_KEY = 'sk-x';
        process.env.API_LLM_TEMPERATURE_OVERRIDE = '0.3';

        // Non-config blob → no byok, and models stays [] (not a v2 config).
        const result = describeLLMConfigStatus(undefined);
        expect(result.source).toBe('env');
        expect(result.models).toEqual([]);
        expect(result.byok).toEqual({ configured: false });
        expect(result.env).toEqual({
            configured: true,
            model: 'gpt-4o-mini',
            providerId: 'openai_compatible',
            baseUrl: 'https://api.openai.com/v1',
            temperatureOverride: 0.3,
        });
    });

    it('managed-only config: resolvable follows env reachability, source falls to env', () => {
        const config: BYOKConfig = {
            version: 2,
            credentials: [{ id: 'm1', provider: 'openai', managed: true }],
            models: [{ id: 'mm1', credentialId: 'm1', model: 'gpt-4o' }],
        };

        // env UNconfigured → managed model not resolvable, source "none"
        const unreachable = describeLLMConfigStatus(config);
        expect(unreachable.source).toBe('none');
        expect(unreachable.byok).toEqual({ configured: false });
        expect(unreachable.models).toEqual([
            {
                modelId: 'mm1',
                model: 'gpt-4o',
                providerId: 'openai',
                baseUrl: undefined,
                resolvable: false,
                capabilities: {
                    structuredOutput: 'json_schema',
                    toolCalling: 'native',
                },
            },
        ]);

        // env configured → same managed model becomes resolvable, source "env"
        process.env.API_LLM_PROVIDER_MODEL = 'gpt-4o-mini';
        process.env.API_OPEN_AI_API_KEY = 'sk-x';
        const reachable = describeLLMConfigStatus(config);
        expect(reachable.source).toBe('env');
        expect(reachable.models[0].resolvable).toBe(true);
    });

    it('enumerates every model in order, masks secrets, maps credential + baseUrl', () => {
        const config: BYOKConfig = {
            version: 2,
            credentials: [
                {
                    id: 'c1',
                    provider: 'openai',
                    apiKey: 'k1',
                    settings: { baseURL: 'https://a/v1' },
                },
                { id: 'c2', provider: 'anthropic', apiKey: 'k2' },
            ],
            models: [
                { id: 'm1', credentialId: 'c1', model: 'gpt-4o' },
                // id-less entry must be filtered out entirely
                { id: '', credentialId: 'c1', model: 'skip-me' } as any,
                { id: 'm2', credentialId: 'c2', model: 'claude-3-5-sonnet-20241022' },
                // dangling credential ref → not resolvable, no provider/caps
                { id: 'm3', credentialId: 'missing', model: 'ghost' },
            ],
        };

        const { models } = describeLLMConfigStatus(config);

        // exact order + membership: the id-less entry is gone
        expect(models.map((m) => m.modelId)).toEqual(['m1', 'm2', 'm3']);

        expect(models[0]).toEqual({
            modelId: 'm1',
            model: 'gpt-4o',
            providerId: 'openai',
            baseUrl: 'https://a/v1',
            resolvable: true,
            capabilities: { structuredOutput: 'json_schema', toolCalling: 'native' },
        });

        expect(models[1]).toEqual({
            modelId: 'm2',
            model: 'claude-3-5-sonnet-20241022',
            providerId: 'anthropic',
            baseUrl: undefined, // no settings.baseURL on c2
            resolvable: true,
            capabilities: { structuredOutput: 'none', toolCalling: 'native' },
        });

        expect(models[2]).toEqual({
            modelId: 'm3',
            model: 'ghost',
            providerId: undefined,
            baseUrl: undefined,
            resolvable: false,
            capabilities: undefined, // dangling credential → unknown provider
        });

        // no secret ever leaks onto the projection
        for (const m of models) {
            expect(m).not.toHaveProperty('apiKey');
            expect(m).not.toHaveProperty('awsSecretAccessKey');
        }
    });

    it('non-string settings.baseURL is dropped (only string metadata surfaces)', () => {
        const config: BYOKConfig = {
            version: 2,
            credentials: [
                {
                    id: 'c1',
                    provider: 'openai',
                    apiKey: 'k1',
                    settings: { baseURL: 12345 as any },
                },
            ],
            models: [{ id: 'm1', credentialId: 'c1', model: 'gpt-4o' }],
        };

        expect(describeLLMConfigStatus(config).models[0].baseUrl).toBeUndefined();
    });
});
