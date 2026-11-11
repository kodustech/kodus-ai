import { prRiskConfigurationKey } from './risk-configuration';
import { resolveTaskSlot } from '@libs/llm/resolve-task-model';
import { LLM_TASK, type BYOKConfig } from '@libs/llm/byok-config';
import {
    isCurrentRiskAssessment,
    type RiskAssessmentResult,
} from './risk-assessment';

it('normalizes optional criteria and language defaults for configuration identity', () => {
    expect(prRiskConfigurationKey({})).toBe(
        prRiskConfigurationKey({ criteria: [], language: 'en-US' }),
    );
});

it.each(['primary', 'fallback'] as const)(
    'invalidates stable IDs when the %s endpoint or inference settings change',
    (target) => {
        const stored: BYOKConfig = {
            version: 2,
            credentials: [
                {
                    id: 'p',
                    provider: 'openai',
                    apiKey: 'encrypted-p',
                    settings: { baseURL: 'https://primary.example/v1' },
                },
                {
                    id: 'f',
                    provider: 'openai',
                    apiKey: 'encrypted-f',
                    settings: { baseURL: 'https://fallback.example/v1' },
                },
            ],
            models: [
                {
                    id: 'primary',
                    credentialId: 'p',
                    model: 'gpt-4o',
                    temperature: 0.1,
                },
                {
                    id: 'fallback',
                    credentialId: 'f',
                    model: 'gpt-4o-mini',
                    temperature: 0.1,
                },
            ],
            routing: { defaultModelId: 'primary', fallbackModelId: 'fallback' },
        };
        const key = () =>
            prRiskConfigurationKey({
                modelSlot: resolveTaskSlot(stored, LLM_TASK.riskAssessment)
                    .slot,
            });
        const before = key();
        const index = target === 'primary' ? 0 : 1;
        stored.credentials[index].settings.baseURL =
            'https://edited.example/v1';
        expect(key()).not.toBe(before);
        stored.credentials[index].settings.baseURL =
            index === 0
                ? 'https://primary.example/v1'
                : 'https://fallback.example/v1';
        stored.models[index].temperature = 0.8;
        expect(key()).not.toBe(before);
    },
);

it('invalidates changed criteria, model and fallback without storing credentials in the identity', () => {
    const slot = {
        byokModelId: 'model',
        credentialId: 'credential',
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'private-a',
    } as any;
    const key = prRiskConfigurationKey({ modelSlot: slot });
    expect(
        prRiskConfigurationKey({ modelSlot: { ...slot, apiKey: 'private-b' } }),
    ).toBe(key);
    expect(
        prRiskConfigurationKey({
            modelSlot: { ...slot, model: 'gpt-4o-mini' },
        }),
    ).not.toBe(key);
    expect(
        prRiskConfigurationKey({
            modelSlot: {
                ...slot,
                fallback: { ...slot, byokModelId: 'fallback' },
            },
        }),
    ).not.toBe(key);
    expect(
        prRiskConfigurationKey({
            modelSlot: slot,
            criteria: [
                {
                    id: 'access',
                    name: 'Access',
                    enabled: true,
                    instructions: 'Check isolation.',
                },
            ],
        }),
    ).not.toBe(key);
});

describe('cron snapshot validation', () => {
    const expected = {
        organizationId: 'org',
        repositoryId: 'repo',
        prNumber: 1,
        baseSha: 'base',
        headSha: 'head',
        configurationKey: prRiskConfigurationKey({}),
    };
    const result: RiskAssessmentResult = {
        status: 'assessed',
        riskIdentified: false,
        reason: 'No material exposure.',
        snapshot: { ...expected, assessmentKey: 'key' },
    };

    it('accepts a judgment only for this exact PR, base/head and configuration', () => {
        expect(isCurrentRiskAssessment(result, expected)).toBe(true);
    });
    it('invalidates assessments made before the provider-patch completeness guard', () => {
        // Managed/default configuration identity recorded by real PR #871.
        const oldKey =
            'd05f34bb6df785b943b84cfe7308ba728f15b3a542d1d92085d82a58692d0ab5';
        expect(
            isCurrentRiskAssessment(
                {
                    ...result,
                    snapshot: { ...result.snapshot, configurationKey: oldKey },
                },
                expected,
            ),
        ).toBe(false);
    });
    it.each(Object.keys(expected))('rejects changed %s', (key) => {
        expect(
            isCurrentRiskAssessment(result, {
                ...expected,
                [key]: key === 'prNumber' ? 2 : 'changed',
            }),
        ).toBe(false);
    });
    it('does not reuse an assessment whose configuration or provider base is unknown', () => {
        expect(
            isCurrentRiskAssessment(
                {
                    status: 'assessed',
                    reason: 'Stored snapshot.',
                    snapshot: result.snapshot,
                },
                expected,
            ),
        ).toBe(false);
        expect(
            isCurrentRiskAssessment(
                {
                    ...result,
                    snapshot: {
                        ...result.snapshot,
                        configurationKey: undefined,
                    },
                },
                expected,
            ),
        ).toBe(false);
        expect(
            isCurrentRiskAssessment(result, { ...expected, baseSha: '' }),
        ).toBe(false);
        expect(
            isCurrentRiskAssessment(
                { status: 'unavailable', reason: 'Failed.' },
                expected,
            ),
        ).toBe(false);
    });
});
