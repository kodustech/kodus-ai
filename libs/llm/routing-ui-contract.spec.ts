import { describeLLMConfigStatus } from '@libs/llm/llm-config-status';
import { BYOKProvider } from '@libs/llm/model-providers';
import { REGISTRY } from '@libs/llm/providers';
import { resolveTaskSlot } from '@libs/llm/resolve-task-model';
import { overrideContext } from '@libs/llm/routing-strategy';
import { resolveModelSlot } from '@libs/llm/resolve-model-slot';
import type { BYOKConfig as StoredConfig } from '@libs/llm/byok-config';
import type { LLMConfigStatus } from '@services/organizationParameters/fetch';

import {
    draftTaskModel,
    hasRoutingProvider,
    mergeRoutingEdits,
    normalizeRouting,
    routingHref,
    routingModelLabels,
} from '../../apps/web/src/features/ee/byok/_components/routing/routing-state';

const providers = [
    BYOKProvider.OPENAI,
    BYOKProvider.ANTHROPIC,
    BYOKProvider.GOOGLE_GEMINI,
    BYOKProvider.GOOGLE_VERTEX,
    BYOKProvider.AMAZON_BEDROCK,
    BYOKProvider.OPEN_ROUTER,
    BYOKProvider.OPENAI_COMPATIBLE,
    BYOKProvider.KODUS,
];
const configFor = (provider: BYOKProvider): StoredConfig => ({
    version: 2,
    credentials: [
        {
            id: 'credential-a',
            provider,
            ...(provider === BYOKProvider.KODUS
                ? {}
                : provider === BYOKProvider.AMAZON_BEDROCK
                  ? { settings: { awsBearerToken: 'fixture-not-real' } }
                  : { apiKey: 'fixture-not-real' }),
        },
    ],
    models: [{ id: 'model-a', credentialId: 'credential-a', model: 'gpt-4o' }],
    routing: { defaultModelId: 'model-a' },
});

describe('routing provider gate', () => {
    it('does not unlock an empty model pool from the default-provider flag alone', () => {
        expect(
            hasRoutingProvider({
                source: 'byok',
                byok: { configured: true },
                env: { configured: false },
                models: [],
            }),
        ).toBe(false);
    });
    it.each(providers)(
        'recognizes a configured %s slot without making an inference request',
        (provider) => {
            const status = describeLLMConfigStatus(configFor(provider));
            expect(hasRoutingProvider(status as LLMConfigStatus)).toBe(true);
            expect(status.models[0].credentialId).toBe('credential-a');
            expect(JSON.stringify(status)).not.toContain('fixture-not-real');
        },
    );
    it('does not unlock for env-only or managed-only models', () => {
        const env = {
            source: 'env',
            byok: { configured: false },
            env: { configured: true },
            models: [],
        } as LLMConfigStatus;
        expect(hasRoutingProvider(env)).toBe(false);
        expect(
            hasRoutingProvider({
                ...env,
                models: [
                    {
                        modelId: 'managed',
                        managed: true,
                        providerId: 'openai',
                        resolvable: true,
                    },
                ],
            }),
        ).toBe(false);
        expect(hasRoutingProvider(null)).toBe(false);
    });
    it('lets an editor repair a bad default when another provider is connected', () => {
        const status = {
            source: 'none',
            byok: { configured: false },
            env: { configured: false },
            models: [
                {
                    modelId: 'bad-default',
                    providerId: 'openai',
                    resolvable: false,
                },
                {
                    modelId: 'connected',
                    providerId: 'anthropic',
                    resolvable: true,
                },
            ],
        } as LLMConfigStatus;
        expect(hasRoutingProvider(status)).toBe(true);
        expect(
            hasRoutingProvider({
                ...status,
                models: status.models.slice(0, 1),
            }),
        ).toBe(false);
    });
    it('retains both gateway identities and surfaces no credential material', () => {
        const config = configFor(BYOKProvider.OPENAI_COMPATIBLE);
        config.credentials[0].settings = {
            baseURL: 'https://first.example/v1',
        };
        config.credentials.push({
            id: 'credential-b',
            provider: BYOKProvider.OPENAI_COMPATIBLE,
            apiKey: 'other-fixture-secret',
            settings: { baseURL: 'https://second.example/v1' },
        });
        config.models.push({
            id: 'model-b',
            credentialId: 'credential-b',
            model: 'gpt-4o',
        });
        const status = describeLLMConfigStatus(config);
        expect(status.models.map((model) => model.credentialId)).toEqual([
            'credential-a',
            'credential-b',
        ]);
        expect(status.models.map((model) => model.baseUrl)).toEqual([
            'https://first.example/v1',
            'https://second.example/v1',
        ]);
        expect(JSON.stringify(status)).not.toMatch(
            /fixture-not-real|other-fixture-secret/,
        );
    });
});

describe('routing edits preserve other work', () => {
    it('merges only edited fields over a fresh configuration', () => {
        const baseline = {
            defaultModelId: 'a',
            fallbackModelId: 'b',
            taskOverrides: { codeReview: 'c' },
        };
        const draft = {
            ...baseline,
            defaultModelId: 'd',
            fallbackModelId: undefined,
            taskOverrides: { codeReview: 'e' },
        };
        const current = {
            defaultModelId: 'a',
            fallbackModelId: 'b',
            taskOverrides: {
                codeReview: 'c',
                conversation: 'new-chat',
                customAgent: 'new-agent',
            },
        };
        expect(mergeRoutingEdits(baseline, draft, current)).toEqual({
            mode: 'manual',
            defaultModelId: 'd',
            fallbackModelId: undefined,
            taskOverrides: {
                codeReview: 'e',
                conversation: 'new-chat',
                customAgent: 'new-agent',
            },
        });
    });
    it("does not overwrite someone else's changed default when only a task was edited", () => {
        expect(
            mergeRoutingEdits(
                { defaultModelId: 'a' },
                {
                    defaultModelId: 'a',
                    taskOverrides: { riskAssessment: 'risk' },
                },
                {
                    defaultModelId: 'new-default',
                    fallbackModelId: 'new-fallback',
                },
            ),
        ).toMatchObject({
            defaultModelId: 'new-default',
            fallbackModelId: 'new-fallback',
            taskOverrides: { riskAssessment: 'risk' },
        });
    });
    it('clearing a redundant pin really inherits future default changes', () => {
        const normalized = normalizeRouting({
            defaultModelId: 'b',
            taskOverrides: { codeReview: 'b', riskAssessment: 'c' },
        });
        expect(normalized.taskOverrides).toEqual({ riskAssessment: 'c' });
        expect(
            normalizeRouting({ ...normalized, defaultModelId: 'd' })
                .taskOverrides?.codeReview,
        ).toBeUndefined();
    });
});

describe('draft task labels agree with the kernel', () => {
    afterEach(() => jest.restoreAllMocks());
    it.each([
        'codeReview',
        'codeReviewHeavy',
        'riskAssessment',
        'conversation',
        'customAgent',
    ] as const)(
        '%s uses the same override/default/fallback and capability gate',
        (task) => {
            const provider = REGISTRY.get(BYOKProvider.OPENAI);
            const original = provider.capabilities.bind(provider);
            jest.spyOn(provider, 'capabilities').mockImplementation((model) =>
                model === 'fixture-unstructured'
                    ? {
                          ...original('gpt-4o'),
                          structuredOutput: 'none',
                          toolCalling: 'none',
                      }
                    : original(model),
            );
            const config = configFor(BYOKProvider.OPENAI);
            config.models[0].model = 'fixture-unstructured';
            config.models.push({
                id: 'fallback',
                credentialId: 'credential-a',
                model: 'gpt-4o',
            });
            config.routing = {
                defaultModelId: 'model-a',
                fallbackModelId: 'fallback',
                taskOverrides: { [task]: 'model-a' },
            };
            const status = describeLLMConfigStatus(config) as LLMConfigStatus;
            expect(draftTaskModel(task, config.routing, status)).toBe(
                resolveTaskSlot(config, task).slot?.byokModelId,
            );
            expect(
                draftTaskModel(task, config.routing, status, 'model-a'),
            ).toBe(
                resolveTaskSlot(config, task, {
                    ctx: overrideContext('model-a'),
                }).slot?.byokModelId,
            );
            expect(
                draftTaskModel(
                    task,
                    { ...config.routing, fallbackModelId: undefined },
                    status,
                ),
            ).toBeUndefined();
        },
    );
});

it('keeps legacy deep links inside canonical Routing and rejects malformed anchors', () => {
    expect(routingHref('task:codeReviewHeavy')).toBe(
        '/settings/code-review/global/routing#task%3AcodeReviewHeavy',
    );
    expect(routingHref('fallback')).toBe(
        '/settings/code-review/global/routing#fallback',
    );
    expect(routingHref('javascript:alert(1)')).toBe(
        '/settings/code-review/global/routing',
    );
});

it('distinguishes identical model names across providers and gateways without exposing URL credentials', () => {
    const models = [
        {
            modelId: 'native',
            model: 'gpt-4o',
            providerId: 'openai',
            resolvable: true,
        },
        {
            modelId: 'gateway-a',
            model: 'gpt-4o',
            providerId: 'openai_compatible',
            credentialId: 'a',
            baseUrl:
                'https://user:private-password@first.example/v1?key=private-key',
            resolvable: true,
        },
        {
            modelId: 'gateway-b',
            model: 'gpt-4o',
            providerId: 'openai_compatible',
            credentialId: 'b',
            baseUrl: 'https://second.example/v1',
            resolvable: true,
        },
    ];
    const labels = routingModelLabels(models);
    expect(labels.get('native')).toContain('OpenAI');
    expect(labels.get('gateway-a')).toContain('first.example');
    expect(labels.get('gateway-b')).toContain('second.example');
    expect(new Set(labels.values()).size).toBe(3);
    expect([...labels.values()].join(' ')).not.toMatch(
        /private-password|private-key|user:/,
    );
    const sameHost = routingModelLabels(
        models
            .slice(1)
            .map((model) => ({ ...model, baseUrl: 'https://same.example/v1' })),
    );
    expect(new Set(sameHost.values()).size).toBe(2);
});

it.each([
    {
        provider: BYOKProvider.AMAZON_BEDROCK,
        apiKey: 'wrong-auth-shape',
        settings: {},
    },
    {
        provider: BYOKProvider.AMAZON_BEDROCK,
        apiKey: undefined,
        settings: { awsAccessKeyId: 'incomplete-pair' },
    },
    {
        provider: BYOKProvider.OPENAI,
        apiKey: undefined,
        settings: { awsBearerToken: 'wrong-provider-auth' },
    },
])(
    'metadata, runtime slots and draft labels agree on unusable $provider auth',
    (credential) => {
        const config = configFor(credential.provider);
        config.credentials[0] = { ...config.credentials[0], ...credential };
        const status = describeLLMConfigStatus(config) as LLMConfigStatus;
        expect(resolveModelSlot(config, 'model-a')).toBeUndefined();
        expect(status.models[0].resolvable).toBe(false);
        expect(hasRoutingProvider(status)).toBe(false);
        expect(status.reviewModels?.balanced.modelId).toBeUndefined();
        expect(
            draftTaskModel('codeReview', config.routing!, status),
        ).toBeUndefined();
        expect(JSON.stringify(status)).not.toContain('wrong-auth');
    },
);
