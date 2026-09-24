import { UserRole } from '@enums';
import { Action, ResourceType } from '@services/permissions/types';

import type { BYOKConfig } from './_types';
import {
    groupModelsByProvider,
    hasVisibleModels,
    isBYOKSubscriptionPlan,
    isEnterprisePlan,
    isTeamsOrEnterprisePlan,
    maskKey,
    modelLabelFor,
    providerFromModel,
} from './_utils';

describe('BYOK topbar visibility', () => {
    const activeBYOKLicense = {
        subscriptionStatus: 'active',
        planType: 'teams_byok',
    } as const;
    const licensedSelfHostedEnterprise = {
        valid: true,
        subscriptionStatus: 'licensed-self-hosted',
        planType: 'enterprise',
        numberOfLicenses: 0,
    } as const;
    const noneStatus = {
        source: 'none',
        byok: { configured: false },
        env: { configured: false },
    } as const;
    const envStatus = {
        source: 'env',
        byok: { configured: false },
        env: {
            configured: true,
            model: 'gpt-4o',
            providerId: 'openai_compatible',
            baseUrl: 'https://api.openai.com/v1',
        },
    } as const;
    const byokStatus = {
        source: 'byok',
        byok: { configured: true, model: 'gpt-4o', providerId: 'openai' },
        env: { configured: false },
    } as const;

    it('does not show the missing key topbar when the user cannot update organization settings', async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import('./_utils');

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: activeBYOKLicense as any,
                llmConfigStatus: noneStatus as any,
                organizationId: 'org-1',
                permissions: {
                    [ResourceType.CodeReviewSettings]: {
                        [Action.Manage]: {
                            organizationId: 'org-1',
                        },
                    },
                },
            }),
        ).toBe(false);
    });

    it('shows the missing key topbar when the user can update organization settings', async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import('./_utils');

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: activeBYOKLicense as any,
                llmConfigStatus: noneStatus as any,
                organizationId: 'org-1',
                permissions: {
                    [ResourceType.OrganizationSettings]: {
                        [Action.Update]: {
                            organizationId: 'org-1',
                        },
                    },
                },
            }),
        ).toBe(true);
    });

    it('shows the missing key topbar when the user has global manage permission', async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import('./_utils');

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: activeBYOKLicense as any,
                llmConfigStatus: noneStatus as any,
                organizationId: 'org-1',
                permissions: {
                    [ResourceType.All]: {
                        [Action.Manage]: {
                            organizationId: 'org-1',
                        },
                    },
                },
            }),
        ).toBe(true);
    });

    it('shows the missing key topbar for owner even when permissions are unavailable', async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import('./_utils');

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: activeBYOKLicense as any,
                llmConfigStatus: noneStatus as any,
                organizationId: 'org-1',
                permissions: {},
                role: UserRole.OWNER,
            }),
        ).toBe(true);
    });

    it('treats licensed self-hosted enterprise as BYOK for the missing key topbar', async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import('./_utils');

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: licensedSelfHostedEnterprise as any,
                llmConfigStatus: noneStatus as any,
                organizationId: 'org-1',
                permissions: {},
                role: UserRole.OWNER,
            }),
        ).toBe(true);
    });

    it('treats trial subscriptions as BYOK eligible (no planType to inspect)', async () => {
        const { isBYOKSubscriptionPlan } = await import('./_utils');

        expect(
            isBYOKSubscriptionPlan({
                valid: true,
                subscriptionStatus: 'trial',
                trialEnd: new Date().toISOString(),
            } as any),
        ).toBe(true);
    });

    it('does not show the missing key topbar for trial orgs (BYOK is optional during trial)', async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import('./_utils');

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: {
                    valid: true,
                    subscriptionStatus: 'trial',
                    trialEnd: new Date().toISOString(),
                } as any,
                llmConfigStatus: noneStatus as any,
                organizationId: 'org-1',
                permissions: {},
                role: UserRole.OWNER,
            }),
        ).toBe(false);
    });

    it('does not show the missing key topbar when the LLM is configured via env', async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import('./_utils');

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: licensedSelfHostedEnterprise as any,
                llmConfigStatus: envStatus as any,
                organizationId: 'org-1',
                permissions: {},
                role: UserRole.OWNER,
            }),
        ).toBe(false);
    });

    it('does not show the missing key topbar when BYOK is configured', async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import('./_utils');

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: activeBYOKLicense as any,
                llmConfigStatus: byokStatus as any,
                organizationId: 'org-1',
                permissions: {},
                role: UserRole.OWNER,
            }),
        ).toBe(false);
    });

    it('does not treat canceled/expired/payment_failed subscriptions as BYOK eligible', async () => {
        const { isBYOKSubscriptionPlan } = await import('./_utils');

        for (const status of [
            'canceled',
            'expired',
            'payment_failed',
            'inactive',
        ] as const) {
            expect(
                isBYOKSubscriptionPlan({
                    subscriptionStatus: status,
                    planType: 'teams_byok',
                } as any),
            ).toBe(false);
        }
    });
});

/** A v2 config: 2 models on 1 non-managed credential + 1 model on a managed one. */
const configWithManaged: BYOKConfig = {
    version: 2,
    credentials: [
        { id: 'cred-byok', provider: 'openai', apiKey: 'sk-••••1234' },
        { id: 'cred-managed', provider: 'google_gemini', managed: true },
    ],
    models: [
        { id: 'm1', credentialId: 'cred-byok', model: 'gpt-4o' },
        { id: 'm2', credentialId: 'cred-byok', model: 'gpt-4o-mini' },
        { id: 'm3', credentialId: 'cred-managed', model: 'gemini-2.5-flash' },
    ],
};

describe('groupModelsByProvider', () => {
    it("returns one group per NON-managed credential with only that credential's models", () => {
        const groups = groupModelsByProvider(configWithManaged);

        // The managed credential produces NO group.
        expect(groups).toHaveLength(1);
        expect(groups[0].credential.id).toBe('cred-byok');

        // Only the 2 models on the non-managed credential are visible; the
        // model on the managed credential is excluded.
        expect(groups[0].models.map((m) => m.id)).toEqual(['m1', 'm2']);
    });

    it('returns [] for null / undefined / a non-v2 blob', () => {
        expect(groupModelsByProvider(null)).toEqual([]);
        expect(groupModelsByProvider(undefined)).toEqual([]);
        // legacy { main, fallback } blob is not v2 → no groups.
        expect(
            groupModelsByProvider({ main: {}, fallback: {} } as never),
        ).toEqual([]);
    });

    it('tolerates an absent routing block without throwing', () => {
        const noRouting: BYOKConfig = {
            version: 2,
            credentials: [{ id: 'c', provider: 'openai', apiKey: 'sk-••••' }],
            models: [{ id: 'm', credentialId: 'c', model: 'gpt-4o' }],
        };
        expect(() => groupModelsByProvider(noRouting)).not.toThrow();
        expect(groupModelsByProvider(noRouting)[0].models).toHaveLength(1);
    });
});

describe('hasVisibleModels (first-run check)', () => {
    it('is false for null / undefined / a non-v2 blob', () => {
        expect(hasVisibleModels(null)).toBe(false);
        expect(hasVisibleModels(undefined)).toBe(false);
        expect(hasVisibleModels({ main: {} } as never)).toBe(false);
    });

    it('is false when the only credential is managed', () => {
        const managedOnly: BYOKConfig = {
            version: 2,
            credentials: [
                { id: 'cm', provider: 'google_gemini', managed: true },
            ],
            models: [
                { id: 'm', credentialId: 'cm', model: 'gemini-2.5-flash' },
            ],
        };
        expect(hasVisibleModels(managedOnly)).toBe(false);
    });

    it('is false when a non-managed credential has no model yet', () => {
        const noModels: BYOKConfig = {
            version: 2,
            credentials: [{ id: 'c', provider: 'openai', apiKey: 'sk-••••' }],
            models: [],
        };
        expect(hasVisibleModels(noModels)).toBe(false);
    });

    it('is true when ≥1 non-managed credential has a model', () => {
        expect(hasVisibleModels(configWithManaged)).toBe(true);
    });
});

// NOTE: temperature/reasoning support is no longer a web mirror — it's read from
// the PROVIDER module server-side (get-model-capabilities.use-case). Its coverage
// lives in libs/organization .../get-model-capabilities.use-case.spec.ts and each
// provider module's own capability specs, so this file no longer tests it.

// ─── mutation-killing coverage for the remaining deterministic helpers ────────

describe('modelLabelFor', () => {
    const pool = [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Bravo' },
    ];

    it('returns the matching label when the id is found', () => {
        expect(modelLabelFor(pool, 'a')).toBe('Alpha');
        // Second entry proves it does not always return the first match.
        expect(modelLabelFor(pool, 'b')).toBe('Bravo');
    });

    it('falls back to the raw id when no model matches', () => {
        expect(modelLabelFor(pool, 'zzz')).toBe('zzz');
    });

    it('falls back to the raw id when the pool is empty', () => {
        expect(modelLabelFor([], 'orphan')).toBe('orphan');
    });

    it('falls back to the em-dash when the id is undefined', () => {
        expect(modelLabelFor(pool, undefined)).toBe('—');
        expect(modelLabelFor(pool)).toBe('—');
    });

    it('falls back to the em-dash when the pool is empty and id is undefined', () => {
        expect(modelLabelFor([], undefined)).toBe('—');
    });
});

describe('isBYOKSubscriptionPlan (branch coverage)', () => {
    it('is true for self-hosted regardless of planType', () => {
        expect(
            isBYOKSubscriptionPlan({
                subscriptionStatus: 'self-hosted',
            } as any),
        ).toBe(true);
    });

    it('is true for licensed-self-hosted regardless of planType', () => {
        expect(
            isBYOKSubscriptionPlan({
                subscriptionStatus: 'licensed-self-hosted',
            } as any),
        ).toBe(true);
    });

    it('is true for trial', () => {
        expect(
            isBYOKSubscriptionPlan({ subscriptionStatus: 'trial' } as any),
        ).toBe(true);
    });

    it('is true for active only when the planType includes "byok"', () => {
        expect(
            isBYOKSubscriptionPlan({
                subscriptionStatus: 'active',
                planType: 'teams_byok',
            } as any),
        ).toBe(true);
    });

    it('is false for active when the planType does not include "byok"', () => {
        expect(
            isBYOKSubscriptionPlan({
                subscriptionStatus: 'active',
                planType: 'teams_pro',
            } as any),
        ).toBe(false);
    });
});

describe('isEnterprisePlan', () => {
    it('is false when the license is not valid, even for an enterprise active plan', () => {
        expect(
            isEnterprisePlan({
                valid: false,
                subscriptionStatus: 'active',
                planType: 'enterprise',
            } as any),
        ).toBe(false);
    });

    it('is true for active enterprise_* plans', () => {
        expect(
            isEnterprisePlan({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'enterprise_annual',
            } as any),
        ).toBe(true);
    });

    it('is true for the bare "enterprise" plan on active', () => {
        expect(
            isEnterprisePlan({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'enterprise',
            } as any),
        ).toBe(true);
    });

    it('is false for a non-enterprise active plan', () => {
        expect(
            isEnterprisePlan({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'teams_byok',
            } as any),
        ).toBe(false);
    });

    it('does not treat "enterprise" as a prefix of an unrelated plan (startsWith guard)', () => {
        // "enterprisey" starts with "enterprise" as a substring but not with
        // "enterprise_" and is not exactly "enterprise" → must be false.
        expect(
            isEnterprisePlan({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'enterprisey',
            } as any),
        ).toBe(false);
    });

    it('is true for licensed-self-hosted enterprise', () => {
        expect(
            isEnterprisePlan({
                valid: true,
                subscriptionStatus: 'licensed-self-hosted',
                planType: 'enterprise',
            } as any),
        ).toBe(true);
    });

    it('is false for licensed-self-hosted non-enterprise', () => {
        expect(
            isEnterprisePlan({
                valid: true,
                subscriptionStatus: 'licensed-self-hosted',
                planType: 'teams_byok',
            } as any),
        ).toBe(false);
    });

    it('treats an absent planType as "" (no crash, not enterprise)', () => {
        expect(
            isEnterprisePlan({
                valid: true,
                subscriptionStatus: 'active',
            } as any),
        ).toBe(false);
    });

    it('is true for trial regardless of planType', () => {
        expect(
            isEnterprisePlan({
                valid: true,
                subscriptionStatus: 'trial',
            } as any),
        ).toBe(true);
    });

    it('is false for the default branch (e.g. self-hosted CE)', () => {
        expect(
            isEnterprisePlan({
                valid: true,
                subscriptionStatus: 'self-hosted',
            } as any),
        ).toBe(false);
    });
});

describe('isTeamsOrEnterprisePlan', () => {
    it('is false when the license is not valid', () => {
        expect(
            isTeamsOrEnterprisePlan({
                valid: false,
                subscriptionStatus: 'active',
                planType: 'teams_byok',
            } as any),
        ).toBe(false);
    });

    it('is true for active teams_* plans', () => {
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'teams_byok',
            } as any),
        ).toBe(true);
    });

    it('is true for active enterprise_* plans', () => {
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'enterprise_annual',
            } as any),
        ).toBe(true);
    });

    it('is true for the bare "enterprise" plan on active', () => {
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'enterprise',
            } as any),
        ).toBe(true);
    });

    it('is false for an active plan that is neither teams nor enterprise', () => {
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: 'active',
                planType: 'starter',
            } as any),
        ).toBe(false);
    });

    it('requires ENTERPRISE (not teams) for licensed-self-hosted', () => {
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: 'licensed-self-hosted',
                planType: 'enterprise',
            } as any),
        ).toBe(true);
        // A teams plan on licensed-self-hosted must NOT be allowed.
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: 'licensed-self-hosted',
                planType: 'teams_byok',
            } as any),
        ).toBe(false);
    });

    it('is true for trial regardless of planType', () => {
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: 'trial',
            } as any),
        ).toBe(true);
    });

    it('is false for the default branch', () => {
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: 'self-hosted',
                planType: 'teams_byok',
            } as any),
        ).toBe(false);
    });

    it('treats an absent planType as "" without throwing', () => {
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: 'active',
            } as any),
        ).toBe(false);
    });
});

describe('maskKey', () => {
    it('returns an empty string for an absent key', () => {
        expect(maskKey()).toBe('');
        expect(maskKey(undefined)).toBe('');
        expect(maskKey('')).toBe('');
    });

    it('returns the short-key placeholder at exactly 8 chars (boundary)', () => {
        expect(maskKey('12345678')).toBe('•••• ••••');
    });

    it('returns the short-key placeholder below the boundary', () => {
        expect(maskKey('1234567')).toBe('•••• ••••');
    });

    it('masks the middle at exactly 9 chars (boundary), keeping 4+4', () => {
        expect(maskKey('123456789')).toBe('1234•••••6789');
    });

    it('masks a long key keeping the first 4 and last 4 with a 5-bullet middle', () => {
        expect(maskKey('sk-abcdefghijklmnop')).toBe('sk-a•••••mnop');
    });
});

describe('providerFromModel', () => {
    it('returns undefined for an absent model', () => {
        expect(providerFromModel()).toBeUndefined();
        expect(providerFromModel(undefined)).toBeUndefined();
        expect(providerFromModel('')).toBeUndefined();
    });

    it('infers anthropic from a claude id (case-insensitive)', () => {
        expect(providerFromModel('claude-3-5-sonnet')).toBe('anthropic');
        expect(providerFromModel('CLAUDE-OPUS')).toBe('anthropic');
    });

    it('infers google_gemini from a gemini id', () => {
        expect(providerFromModel('gemini-2.5-flash')).toBe('google_gemini');
    });

    it('infers moonshot from kimi or moonshot ids', () => {
        expect(providerFromModel('kimi-k2')).toBe('moonshot');
        expect(providerFromModel('moonshot-v1-8k')).toBe('moonshot');
    });

    it('infers openai from gpt / o1 / o3 prefixes', () => {
        expect(providerFromModel('gpt-4o')).toBe('openai');
        expect(providerFromModel('GPT-4')).toBe('openai');
        expect(providerFromModel('o1-preview')).toBe('openai');
        expect(providerFromModel('o3-mini')).toBe('openai');
    });

    it('requires gpt/o1/o3 to be a PREFIX, not a substring', () => {
        // "turbo-gpt" contains "gpt" but does not start with it → no match.
        expect(providerFromModel('turbo-gpt')).toBeUndefined();
    });

    it('returns undefined when nothing matches', () => {
        expect(providerFromModel('llama-3-70b')).toBeUndefined();
        expect(providerFromModel('mistral-large')).toBeUndefined();
    });
});
