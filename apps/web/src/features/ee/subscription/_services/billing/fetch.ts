import { authorizedFetch } from "@services/fetch";
import { getOrganizationId } from "@services/organizations/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";
import { isSelfHosted } from "src/core/utils/self-hosted";

import type { OrganizationLicense, Plan, PlanType } from "./types";
import { billingFetch } from "./utils";

type OrganizationMember = {
    id: string | number;
    name?: string | null;
    login?: string | null;
    username?: string | null;
    displayName?: string | null;
};

export const getOrganizationMembers = async (params: { teamId: string }) => {
    return authorizedFetch<Array<OrganizationMember>>(
        pathToApiUrl("/code-management/organization-members"),
        {
            params: { teamId: params.teamId },
        },
    );
};

export const startTeamTrial = async (params: {
    teamId: string;
    organizationId: string;
    byok: boolean;
}) => {
    return billingFetch<{
        id: string;
        organizationId: string;
        teamId: string;
        subscriptionStatus: "trial";
        cloudToken: string;
        trialEnd: Date;
        stripeCustomerId: null;
        stripeSubscriptionId: null;
        totalLicenses: number;
        assignedLicenses: number;
        createdAt: Date;
        updatedAt: Date;
    }>(`trial`, {
        method: "POST",
        body: JSON.stringify({
            organizationId: params.organizationId,
            teamId: params.teamId,
            byok: params.byok,
        }),
    });
};

export const createCheckoutSession = async (params: {
    teamId: string;
    quantity: number;
    planId: string;
}) => {
    const organizationId = await getOrganizationId();

    return billingFetch<{ url: string }>(`create-checkout-session`, {
        method: "POST",
        body: JSON.stringify({
            organizationId,
            teamId: params.teamId,
            quantity: params.quantity,
            planType: params.planId,
        }),
    });
};

export const createManageBillingLink = async (params: { teamId: string }) => {
    const organizationId = await getOrganizationId();

    return billingFetch<{ url: string }>(
        `portal/${organizationId}/${params.teamId}`,
        { method: "GET" },
    );
};

export const getUsersWithLicense = async (params: { teamId: string }) => {
    if (isSelfHosted) {
        try {
            return await authorizedFetch<Array<{ git_id: string }>>(
                pathToApiUrl("/license/users"),
            );
        } catch {
            return [];
        }
    }

    const organizationId = await getOrganizationId();
    return billingFetch<Array<{ git_id: string }>>(`users-with-license`, {
        params: { organizationId, teamId: params.teamId },
    });
};

export const getPlans = () =>
    billingFetch<{
        plans: Array<Plan>;
    }>(`plans`);

export const assignOrDeassignUserLicense = async (params: {
    teamId: string;
    user: {
        gitId: string;
        gitTool: string;
        licenseStatus: "active" | "inactive";
    };
    currentUser?: {
        userId?: string;
        email?: string;
    };
    userName?: string;
}) => {
    if (isSelfHosted) {
        return authorizedFetch<{
            successful: any[];
            failed: any[];
        }>(pathToApiUrl("/license/assign"), {
            method: "POST",
            body: JSON.stringify({
                teamId: params.teamId,
                users: [params.user],
                editedBy: params.currentUser,
                userName: params.userName,
            }),
        });
    }

    const organizationId = await getOrganizationId();

    return billingFetch<{
        successful: any[];
        error: any[];
    }>(`assign-license`, {
        method: "POST",
        body: JSON.stringify({
            organizationId,
            teamId: params.teamId,
            users: [params.user],
            editedBy: params.currentUser,
            userName: params.userName,
        }),
    });
};

export const validateOrganizationLicense = async (params: {
    teamId: string;
}): Promise<OrganizationLicense> => {
    if (isSelfHosted) {
        // Check if there's a self-hosted license key activated
        // Use /license/org-status which is accessible to all org members
        try {
            const result = await authorizedFetch<{
                valid: boolean;
                subscriptionStatus?: string;
                planType?: string;
                numberOfLicenses?: number;
                expiresAt?: string;
            }>(pathToApiUrl("/license/org-status"));

            if (
                result?.valid &&
                result.subscriptionStatus === "licensed-self-hosted"
            ) {
                return {
                    valid: true,
                    subscriptionStatus: "licensed-self-hosted",
                    planType: (result.planType as PlanType) || "enterprise",
                    numberOfLicenses: result.numberOfLicenses || 0,
                    expiresAt: result.expiresAt,
                };
            }
        } catch {
            // License endpoint not available or failed, fall back to default
        }

        return { valid: true, subscriptionStatus: "self-hosted" };
    }

    const organizationId = await getOrganizationId();
    return billingFetch<OrganizationLicense>(`validate-org-license`, {
        method: "GET",
        params: { organizationId, teamId: params.teamId },
    });
};

export const migrateToFree = async (params: {
    organizationId: string;
    teamId: string;
}) => {
    return billingFetch<{
        success: boolean;
        message?: string;
    }>(`migrate-to-free`, {
        method: "POST",
        body: JSON.stringify({
            organizationId: params.organizationId,
            teamId: params.teamId,
        }),
    });
};
