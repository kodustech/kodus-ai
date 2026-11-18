import {
    type ILicenseService,
    type OrganizationLicenseValidationResult,
    SubscriptionStatus,
} from '@libs/ee/license/interfaces/license.interface';
import type { BYOKConfig } from '@libs/llm/byok-config';

import {
    isUltraReviewPlanAllowed,
    isUltraReviewTierAllowed,
    ownModelIds,
    resolveUltraTrio,
} from './ultra-review-plan';
import { normalizeModelId, pickMergeModelIndex } from './ultra-merge-ranking';

const license = (
    subscriptionStatus: SubscriptionStatus | undefined,
    planType?: string,
    valid = true,
): OrganizationLicenseValidationResult => ({
    valid,
    subscriptionStatus,
    planType,
});

describe('isUltraReviewTierAllowed', () => {
    it.each([
        [
            'cloud Teams',
            license(SubscriptionStatus.ACTIVE, 'teams_byok_monthly'),
        ],
        [
            'cloud Enterprise',
            license(SubscriptionStatus.ACTIVE, 'enterprise_byok'),
        ],
        ['a trial', license(SubscriptionStatus.TRIAL, 'teams_managed_monthly')],
        [
            'self-hosted with a Teams key',
            license(SubscriptionStatus.LICENSED_SELF_HOSTED, 'teams'),
        ],
        [
            'self-hosted with an Enterprise key',
            license(SubscriptionStatus.LICENSED_SELF_HOSTED, 'enterprise'),
        ],
    ])('allows %s', (_, l) => {
        expect(isUltraReviewTierAllowed(l)).toBe(true);
    });

    it.each([
        // A trial that ended lands on free_byok: Ultra stops with it.
        [
            'free with BYOK (a trial that ended)',
            license(SubscriptionStatus.ACTIVE, 'free_byok'),
        ],
        [
            'self-hosted without a key',
            license(SubscriptionStatus.SELF_HOSTED, undefined),
        ],
        [
            'an expired plan',
            license(SubscriptionStatus.EXPIRED, 'teams_byok', false),
        ],
        ['a canceled plan', license(SubscriptionStatus.CANCELED, 'teams_byok')],
        [
            'a failed payment',
            license(SubscriptionStatus.PAYMENT_FAILED, 'teams_byok'),
        ],
        ['no license', undefined],
    ])('refuses %s', (_, l) => {
        expect(isUltraReviewTierAllowed(l)).toBe(false);
    });
});

describe('isUltraReviewPlanAllowed', () => {
    const org = { organizationId: 'org', teamId: 'team' };
    const service = (
        result: OrganizationLicenseValidationResult | Error,
    ): ILicenseService =>
        ({
            validateOrganizationLicense: jest.fn(async () => {
                if (result instanceof Error) throw result;
                return result;
            }),
        }) as unknown as ILicenseService;

    it('reads the plan on every call, so a trial that ends loses Ultra', async () => {
        const trial = service(license(SubscriptionStatus.TRIAL, 'teams'));
        expect(await isUltraReviewPlanAllowed(trial, org, 't')).toBe(true);
        const ended = service(license(SubscriptionStatus.ACTIVE, 'free_byok'));
        expect(await isUltraReviewPlanAllowed(ended, org, 't')).toBe(false);
    });

    it('fails closed with no service or a license that cannot be read', async () => {
        expect(await isUltraReviewPlanAllowed(undefined, org, 't')).toBe(false);
        expect(
            await isUltraReviewPlanAllowed(
                service(new Error('down')),
                org,
                't',
            ),
        ).toBe(false);
    });
});

const credential = (id: string, provider: string, extra: object = {}) => ({
    id,
    provider,
    apiKey: `cipher-${id}`,
    ...extra,
});

const config = (overrides: Partial<BYOKConfig> = {}): BYOKConfig => ({
    version: 2,
    credentials: [
        credential('c-openai', 'openai'),
        credential('c-anthropic', 'anthropic'),
        { id: 'c-managed', provider: 'openai', managed: true },
        { id: 'c-kodus', provider: 'kodus' },
    ],
    models: [
        { id: 'm-sol', credentialId: 'c-openai', model: 'gpt-6.1-sol' },
        { id: 'm-opus', credentialId: 'c-anthropic', model: 'claude-opus-5-5' },
        {
            id: 'm-sonnet',
            credentialId: 'c-anthropic',
            model: 'claude-sonnet-5-5',
        },
        { id: 'm-luna', credentialId: 'c-openai', model: 'gpt-6-luna' },
        {
            id: 'm-managed',
            credentialId: 'c-managed',
            model: 'deepseek-v4-flash',
        },
    ],
    routing: {
        defaultModelId: 'm-sol',
        fallbackModelId: 'm-luna',
        ultraModelIds: ['m-sol', 'm-opus', 'm-sonnet'],
    },
    ...overrides,
});

describe('ownModelIds', () => {
    it('counts the models on the team keys, never the managed trial key', () => {
        expect(ownModelIds(config())).toEqual([
            'm-sol',
            'm-opus',
            'm-sonnet',
            'm-luna',
        ]);
    });

    it("counts a model on purchased Kodus credits as the team's own", () => {
        const withCredits = config();
        withCredits.models.push({
            id: 'm-credits',
            credentialId: 'c-kodus',
            model: 'glm-5.3',
        });
        expect(ownModelIds(withCredits)).toContain('m-credits');
    });
});

describe('resolveUltraTrio', () => {
    it('resolves the three models in order, the fallback and the best ranked merge model', () => {
        const r = resolveUltraTrio(config());
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.models.map((m) => [m.position, m.modelId])).toEqual([
            [1, 'm-sol'],
            [2, 'm-opus'],
            [3, 'm-sonnet'],
        ]);
        expect(r.fallback).toMatchObject({
            position: 'fallback',
            modelId: 'm-luna',
        });
        // Opus merges best on the benchmark, whatever its place.
        expect(r.mergeModel.modelId).toBe('m-opus');
        // Ultra spends its one fallback per review, never per call.
        for (const m of [...r.models, r.fallback!]) {
            expect(m.slot.fallback).toBeUndefined();
            expect(m.slot.model).toBeTruthy();
        }
    });

    it('refuses fewer than three own models, counting no managed one', () => {
        const few = config({
            models: config().models.filter((m) =>
                ['m-sol', 'm-opus', 'm-managed'].includes(m.id),
            ),
        });
        expect(resolveUltraTrio(few)).toEqual({
            ok: false,
            reason: 'too_few_models',
            ownModels: 2,
        });
        expect(resolveUltraTrio(null)).toMatchObject({
            ok: false,
            reason: 'too_few_models',
            ownModels: 0,
        });
    });

    it.each([
        ['none set', undefined],
        ['two set', ['m-sol', 'm-opus']],
        ['the same model twice', ['m-sol', 'm-sol', 'm-opus']],
        ['an empty id', ['m-sol', '', 'm-opus']],
    ])('refuses a trio with %s', (_, ids) => {
        const c = config();
        c.routing!.ultraModelIds = ids as string[] | undefined;
        expect(resolveUltraTrio(c)).toMatchObject({
            ok: false,
            reason: 'not_configured',
        });
    });

    it('lists a removed model as unavailable and still runs on the others', () => {
        const c = config();
        c.routing!.ultraModelIds = ['m-sol', 'm-gone', 'm-sonnet'];
        const r = resolveUltraTrio(c);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.models.map((m) => m.modelId)).toEqual(['m-sol', 'm-sonnet']);
        expect(r.unavailable).toEqual([
            expect.objectContaining({ position: 2, modelId: 'm-gone' }),
        ]);
        expect(r.mergeModel.modelId).toBe('m-sonnet');
    });

    it("a managed model set for Ultra is not one of the team's: unavailable", () => {
        const c = config();
        c.routing!.ultraModelIds = ['m-sol', 'm-managed', 'm-sonnet'];
        const r = resolveUltraTrio(c);
        expect(r.ok && r.unavailable?.map((u) => u.modelId)).toEqual([
            'm-managed',
        ]);
    });

    it('refuses when none of the three resolves any more', () => {
        const c = config();
        c.routing!.ultraModelIds = ['x', 'y', 'z'];
        expect(resolveUltraTrio(c)).toMatchObject({
            ok: false,
            reason: 'unavailable_models',
        });
    });

    it('runs with no fallback when none is set, or it does not resolve', () => {
        const c = config();
        c.routing!.fallbackModelId = undefined;
        const r = resolveUltraTrio(c);
        expect(r.ok && r.fallback).toBeFalsy();
        c.routing!.fallbackModelId = 'm-gone';
        const r2 = resolveUltraTrio(c);
        expect(r2.ok && r2.fallback).toBeFalsy();
    });

    it('merges on Model 1 when none of the three is ranked', () => {
        const c = config();
        c.models.push(
            { id: 'u1', credentialId: 'c-openai', model: 'my-tuned-1' },
            { id: 'u2', credentialId: 'c-openai', model: 'my-tuned-2' },
        );
        c.routing!.ultraModelIds = ['u2', 'u1', 'm-luna'];
        const r = resolveUltraTrio(c);
        // gpt-6-luna is ranked, so it wins over Model 1.
        expect(r.ok && r.mergeModel.modelId).toBe('m-luna');
        c.models.push({
            id: 'u3',
            credentialId: 'c-openai',
            model: 'my-tuned-3',
        });
        c.routing!.ultraModelIds = ['u2', 'u1', 'u3'];
        const r2 = resolveUltraTrio(c);
        expect(r2.ok && r2.mergeModel.modelId).toBe('u2');
    });
});

describe('the merge ranking', () => {
    it.each([
        ['claude-opus-5-5', 'claude-opus-5-5'],
        ['anthropic/claude-opus-5.5', 'claude-opus-5-5'],
        ['us.anthropic.claude-opus-5-5-v1:0', 'claude-opus-5-5'],
        ['claude-opus-5-5-20261101', 'claude-opus-5-5'],
        ['accounts/fireworks/models/glm-5p3-flash', 'glm-5-3-flash'],
        ['z-ai/glm-5.3', 'glm-5-3'],
        ['Qwen/Qwen3.8-27B', 'qwen3-8-27b'],
        ['deepseek-v4.1-flash@fireworks', 'deepseek-v4-1-flash'],
        ['moonshotai/kimi-k3.1-pro:free', 'kimi-k3-1-pro'],
    ])('reads %s as %s', (raw, normalized) => {
        expect(normalizeModelId(raw)).toBe(normalized);
    });

    it('keeps a model and its Flash sibling apart', () => {
        expect(pickMergeModelIndex(['glm-5.3', 'glm-5.3-flash'])).toBe(1);
    });

    it('picks the best ranked: Kimi merges worst, after DeepSeek and GLM', () => {
        expect(
            pickMergeModelIndex([
                'kimi-k3.1-pro',
                'accounts/fireworks/models/glm-5p3',
                'deepseek-v4.1-flash',
            ]),
        ).toBe(2);
    });
});
