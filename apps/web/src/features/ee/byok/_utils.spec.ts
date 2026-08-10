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

describe("isTeamsOrEnterprisePlan", () => {
    it("allows active Teams and Enterprise plans", async () => {
        const { isTeamsOrEnterprisePlan } = await import("./_utils");

        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: "active",
                planType: "teams_byok",
            } as any),
        ).toBe(true);
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: "active",
                planType: "enterprise_managed",
            } as any),
        ).toBe(true);
    });

    it("blocks free_byok and unlicensed self-hosted", async () => {
        const { isTeamsOrEnterprisePlan } = await import("./_utils");

        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: "active",
                planType: "free_byok",
            } as any),
        ).toBe(false);
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: "self-hosted",
            } as any),
        ).toBe(false);
    });

    it("allows trial and licensed self-hosted enterprise only", async () => {
        const { isTeamsOrEnterprisePlan } = await import("./_utils");

        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: "trial",
            } as any),
        ).toBe(true);
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: "licensed-self-hosted",
                planType: "enterprise",
            } as any),
        ).toBe(true);
        expect(
            isTeamsOrEnterprisePlan({
                valid: true,
                subscriptionStatus: "licensed-self-hosted",
                planType: "teams_byok",
            } as any),
        ).toBe(false);
    });
});

describe("anthropicRejectsTemperature", () => {
    const check = async (provider?: string, model?: string) => {
        const { anthropicRejectsTemperature } = await import("./_utils");
        return anthropicRejectsTemperature(provider, model);
    };

    it("never hides the field for non-Anthropic providers", async () => {
        // anthropic_compatible endpoints speak the Anthropic protocol but do
        // accept temperature — kimi-k2.7-code even requires temperature=1.
        expect(await check("anthropic_compatible", "kimi-k2.7-code")).toBe(
            false,
        );
        expect(await check("openai", "gpt-5.2")).toBe(false);
        expect(await check(undefined, "claude-opus-5")).toBe(false);
    });

    it("hides the field on Claude 4.7 and newer", async () => {
        for (const model of [
            "claude-opus-4-7",
            "claude-opus-4-8",
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-fable-5",
            "anthropic.claude-opus-5",
            "claude-opus-4-8@20260101",
        ]) {
            expect(await check("anthropic", model)).toBe(true);
        }
    });

    it("keeps the field on Claude models that still accept temperature", async () => {
        for (const model of [
            "claude-3-7-sonnet-20250219",
            "claude-opus-4-20250514",
            "claude-sonnet-4-5-20250929",
            "claude-haiku-4-5",
            "claude-opus-4-6",
        ]) {
            expect(await check("anthropic", model)).toBe(false);
        }
    });

    it("treats an unknown Claude as new, matching the backend", async () => {
        expect(await check("anthropic", "")).toBe(true);
        expect(await check("anthropic", "claude-something-unreleased")).toBe(
            true,
        );
    });
});
