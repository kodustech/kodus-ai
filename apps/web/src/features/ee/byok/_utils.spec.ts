import { UserRole } from '@enums';
import { Action, ResourceType } from '@services/permissions/types';

import type { BYOKConfigV2 } from './_types';
import { groupModelsByProvider, hasVisibleModels } from './_utils';

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
const configWithManaged: BYOKConfigV2 = {
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
        const noRouting: BYOKConfigV2 = {
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
        const managedOnly: BYOKConfigV2 = {
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
        const noModels: BYOKConfigV2 = {
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
