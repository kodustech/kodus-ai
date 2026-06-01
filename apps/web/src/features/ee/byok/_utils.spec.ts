import { UserRole } from "@enums";
import { Action, ResourceType } from "@services/permissions/types";

describe("BYOK topbar visibility", () => {
    const activeBYOKLicense = {
        subscriptionStatus: "active",
        planType: "teams_byok",
    } as const;
    const licensedSelfHostedEnterprise = {
        valid: true,
        subscriptionStatus: "licensed-self-hosted",
        planType: "enterprise",
        numberOfLicenses: 0,
    } as const;
    const noneStatus = {
        source: "none",
        byok: { configured: false },
        env: { configured: false },
    } as const;
    const envStatus = {
        source: "env",
        byok: { configured: false },
        env: {
            configured: true,
            model: "gpt-4o",
            providerId: "openai_compatible",
            baseUrl: "https://api.openai.com/v1",
        },
    } as const;
    const byokStatus = {
        source: "byok",
        byok: { configured: true, model: "gpt-4o", providerId: "openai" },
        env: { configured: false },
    } as const;

    it("does not show the missing key topbar when the user cannot update organization settings", async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import("./_utils");

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: activeBYOKLicense as any,
                llmConfigStatus: noneStatus as any,
                organizationId: "org-1",
                permissions: {
                    [ResourceType.CodeReviewSettings]: {
                        [Action.Manage]: {
                            organizationId: "org-1",
                        },
                    },
                },
            }),
        ).toBe(false);
    });

    it("shows the missing key topbar when the user can update organization settings", async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import("./_utils");

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: activeBYOKLicense as any,
                llmConfigStatus: noneStatus as any,
                organizationId: "org-1",
                permissions: {
                    [ResourceType.OrganizationSettings]: {
                        [Action.Update]: {
                            organizationId: "org-1",
                        },
                    },
                },
            }),
        ).toBe(true);
    });

    it("shows the missing key topbar when the user has global manage permission", async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import("./_utils");

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: activeBYOKLicense as any,
                llmConfigStatus: noneStatus as any,
                organizationId: "org-1",
                permissions: {
                    [ResourceType.All]: {
                        [Action.Manage]: {
                            organizationId: "org-1",
                        },
                    },
                },
            }),
        ).toBe(true);
    });

    it("shows the missing key topbar for owner even when permissions are unavailable", async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import("./_utils");

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: activeBYOKLicense as any,
                llmConfigStatus: noneStatus as any,
                organizationId: "org-1",
                permissions: {},
                role: UserRole.OWNER,
            }),
        ).toBe(true);
    });

    it("treats licensed self-hosted enterprise as BYOK for the missing key topbar", async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import("./_utils");

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: licensedSelfHostedEnterprise as any,
                llmConfigStatus: noneStatus as any,
                organizationId: "org-1",
                permissions: {},
                role: UserRole.OWNER,
            }),
        ).toBe(true);
    });

    it("treats trial subscriptions as BYOK eligible (no planType to inspect)", async () => {
        const { isBYOKSubscriptionPlan } = await import("./_utils");

        expect(
            isBYOKSubscriptionPlan({
                valid: true,
                subscriptionStatus: "trial",
                trialEnd: new Date().toISOString(),
            } as any),
        ).toBe(true);
    });

    it("does not show the missing key topbar for trial orgs (BYOK is optional during trial)", async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import("./_utils");

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: {
                    valid: true,
                    subscriptionStatus: "trial",
                    trialEnd: new Date().toISOString(),
                } as any,
                llmConfigStatus: noneStatus as any,
                organizationId: "org-1",
                permissions: {},
                role: UserRole.OWNER,
            }),
        ).toBe(false);
    });

    it("does not show the missing key topbar when the LLM is configured via env", async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import("./_utils");

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: licensedSelfHostedEnterprise as any,
                llmConfigStatus: envStatus as any,
                organizationId: "org-1",
                permissions: {},
                role: UserRole.OWNER,
            }),
        ).toBe(false);
    });

    it("does not show the missing key topbar when BYOK is configured", async () => {
        const { shouldShowBYOKMissingKeyTopbar } = await import("./_utils");

        expect(
            shouldShowBYOKMissingKeyTopbar({
                license: activeBYOKLicense as any,
                llmConfigStatus: byokStatus as any,
                organizationId: "org-1",
                permissions: {},
                role: UserRole.OWNER,
            }),
        ).toBe(false);
    });

    it("does not treat canceled/expired/payment_failed subscriptions as BYOK eligible", async () => {
        const { isBYOKSubscriptionPlan } = await import("./_utils");

        for (const status of [
            "canceled",
            "expired",
            "payment_failed",
            "inactive",
        ] as const) {
            expect(
                isBYOKSubscriptionPlan({
                    subscriptionStatus: status,
                    planType: "teams_byok",
                } as any),
            ).toBe(false);
        }
    });
});
