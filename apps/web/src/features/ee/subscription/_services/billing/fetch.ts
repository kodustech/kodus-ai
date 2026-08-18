import { authorizedFetch } from "@services/fetch";
import { getOrganizationId } from "@services/organizations/fetch";
import { pathToApiUrl } from "src/core/utils/helpers";
import { isSelfHosted } from "src/core/utils/self-hosted";

import type {
    OrganizationLicense,
    Plan,
    PlanType,
    TrialExtensionRequest,
    TrialExtensionRequestResult,
    TrialUnlock,
    TrialUnlockSignals,
} from "./types";
import { billingFetch } from "./utils";

type OrganizationMember = {
    id: string | number;
    name?: string | null;
    login?: string | null;
    username?: string | null;
    displayName?: string | null;
    /** Absent on responses from an API older than the bot-aware member list. */
    type?: "user" | "bot";
};

export type OrganizationMemberListResult =
    | { status: "ok"; members: Array<OrganizationMember> }
    | { status: "unavailable"; members: [] };

/**
 * Use as the fallback whenever the member list can't be fetched. Never treat an
 * `unavailable` result as "the organization is empty" — that is what made a
 * failed lookup look like everyone had left the git org.
 */
export const MEMBERS_UNAVAILABLE: OrganizationMemberListResult = {
    status: "unavailable",
    members: [],
};

/**
 * Tolerates the pre-status response shape so a rolling deploy where the web app
 * is ahead of the API does not report every member as removed from the org.
 */
const toMemberListResult = (
    response: unknown,
): OrganizationMemberListResult => {
    if (Array.isArray(response)) {
        return response.length > 0
            ? { status: "ok", members: response as Array<OrganizationMember> }
            : { status: "unavailable", members: [] };
    }

    const result = response as OrganizationMemberListResult | undefined;

    if (result?.status === "ok" && Array.isArray(result.members)) {
        return { status: "ok", members: result.members };
    }

    return { status: "unavailable", members: [] };
};

export const getOrganizationMembers = async (params: { teamId: string }) => {
    const response = await authorizedFetch<unknown>(
        pathToApiUrl("/code-management/organization-members"),
        {
            params: { teamId: params.teamId },
        },
    );

    return toMemberListResult(response);
};

export const refreshOrganizationMembers = async (params: {
    teamId: string;
}) => {
    const response = await authorizedFetch<unknown>(
        pathToApiUrl("/code-management/organization-members/refresh"),
        {
            method: "POST",
            params: { teamId: params.teamId },
        },
    );

    return toMemberListResult(response);
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
        byok?: boolean;
        trialReviewCreditsTotal?: number;
        trialReviewCreditsUsed?: number;
        trialReviewCreditsRemaining?: number;
        trialCreditTier?: string;
        trialUnlocks?: Array<TrialUnlock>;
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

export type UserWithLicense = {
    git_id: string;
    status?: "active" | "inactive";
};

export const getUsersWithLicense = async (
    params: { teamId: string },
): Promise<Array<UserWithLicense>> => {
    if (isSelfHosted) {
        try {
            return await authorizedFetch<Array<UserWithLicense>>(
                pathToApiUrl("/license/users"),
            );
        } catch {
            return [];
        }
    }

    const organizationId = await getOrganizationId();
    return billingFetch<Array<UserWithLicense>>(`users-with-license`, {
        params: { organizationId, teamId: params.teamId },
    });
};

export type PruneSeatsResult = {
    status: "ok" | "members_unavailable";
    candidates: string[];
    revoked: string[];
    failed: string[];
};

export const getRemovableSeats = async (params: { teamId: string }) => {
    return authorizedFetch<PruneSeatsResult>(
        pathToApiUrl("/license/removable-seats"),
        { params: { teamId: params.teamId } },
    );
};

export const pruneRemovedSeats = async (params: {
    teamId: string;
    gitIds?: string[];
}) => {
    return authorizedFetch<PruneSeatsResult>(
        pathToApiUrl("/license/prune-seats"),
        {
            method: "POST",
            body: JSON.stringify({
                teamId: params.teamId,
                gitIds: params.gitIds,
            }),
        },
    );
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

export const recalculateTrialUnlocks = async (params: {
    teamId: string;
    signals: TrialUnlockSignals;
}): Promise<OrganizationLicense | undefined> => {
    if (isSelfHosted) {
        return undefined;
    }

    const organizationId = await getOrganizationId();
    return billingFetch<OrganizationLicense>(`trial-unlocks/recalculate`, {
        method: "POST",
        body: JSON.stringify({
            organizationId,
            teamId: params.teamId,
            signals: params.signals,
        }),
    });
};

export const requestTrialExtension = async (params: {
    teamId: string;
    request: TrialExtensionRequest;
}): Promise<TrialExtensionRequestResult> => {
    // Goes through the API, which owns the Discord webhook secret and resolves
    // the org + requesting user server-side from the JWT.
    try {
        const data = await authorizedFetch<TrialExtensionRequestResult>(
            pathToApiUrl("/license/trial-extension-request"),
            {
                method: "POST",
                body: JSON.stringify({
                    teamId: params.teamId,
                    teamSize: params.request.teamSize,
                    message: params.request.message,
                }),
            },
        );

        if (!data?.success) {
            return {
                success: false,
                message: data?.message ?? "Request failed",
            };
        }

        return data;
    } catch {
        return { success: false, message: "Request failed" };
    }
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
