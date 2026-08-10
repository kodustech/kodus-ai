/**
 * Interface and types for license service.
 */

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export enum SubscriptionStatus {
    TRIAL = 'trial',
    ACTIVE = 'active',
    PAYMENT_FAILED = 'payment_failed',
    CANCELED = 'canceled',
    EXPIRED = 'expired',
    SELF_HOSTED = 'self-hosted',
    LICENSED_SELF_HOSTED = 'licensed-self-hosted',
}

export type SelfHostedLicensePayload = {
    iss: string;
    sub: string;
    iat: number;
    exp: number;
    plan: string;
    seats: number;
    features: string[];
    customer: string;
};

export type OrganizationLicenseValidationResult = {
    valid: boolean;
    subscriptionStatus?: SubscriptionStatus;
    trialEnd?: Date;
    numberOfLicenses?: number;
    planType?: string;
    expiresAt?: string;
    byok?: boolean;
    trialReviewCreditsTotal?: number;
    trialReviewCreditsUsed?: number;
    trialReviewCreditsRemaining?: number;
    trialCreditTier?: string;
    trialUnlocks?: TrialUnlock[];
};

export type UserWithLicense = {
    git_id: string;
    status?: 'active' | 'inactive';
};

export type TrialUnlock = {
    key: string;
    status: 'locked' | 'available' | 'completed' | 'claimed' | string;
    rewardCredits?: number;
    title?: string;
    description?: string;
    completedAt?: string;
};

export type ConsumeTrialReviewCreditResult = {
    allowed: boolean;
    reason?: string;
    alreadyConsumed?: boolean;
    trialReviewCreditsTotal?: number;
    trialReviewCreditsUsed?: number;
    trialReviewCreditsRemaining?: number;
    trialCreditTier?: string;
    trialUnlocks?: TrialUnlock[];
};

export const LICENSE_SERVICE_TOKEN = Symbol.for('LicenseService');

export interface ILicenseService {
    /**
     * Validate organization license.
     *
     * @param organizationAndTeamData Organization ID and team ID.
     * @returns Promise with validation result.
     */
    validateOrganizationLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationLicenseValidationResult>;

    /**
     * Get all users with license.
     *
     * @param params Organization ID and team ID.
     * @returns Promise with array of users with license.
     */
    getAllUsersWithLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<UserWithLicense[]>;

    /**
     * Get all users ever assigned a license (including inactive).
     *
     * @param params Organization ID and team ID.
     * @returns Promise with array of all users ever assigned a license.
     */
    getAllUsersEverWithLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<UserWithLicense[]>;

    /**
     * Assign license to a user.
     *
     * @param organizationAndTeamData Organization ID and team ID.
     * @param userGitId Git ID of the user to assign license to.
     * @param provider The git provider (e.g., 'github', 'gitlab').
     * @returns Promise with boolean indicating success.
     */
    assignLicense(
        organizationAndTeamData: OrganizationAndTeamData,
        userGitId: string,
        provider: string,
    ): Promise<boolean>;

    /**
     * Release several license seats in one shot.
     *
     * Deliberately batched rather than called once per user: both backends
     * read the seat list, mutate it and write the whole thing back, so
     * concurrent single-user revokes lose updates. Measured against the billing
     * service, five concurrent revokes left its assignedLicenses counter at 3
     * instead of 0; the same five sent as one batch settled at 0.
     *
     * Idempotent: revoking a seat the user does not hold succeeds.
     *
     * @param organizationAndTeamData Organization ID and team ID.
     * @param userGitIds Git IDs of the users to release seats from.
     * @param provider The git provider (e.g., 'github', 'gitlab'). Required by
     *   the billing service, which rejects a user entry without a gitTool.
     * @returns The git ids actually released, and those that could not be.
     */
    unassignLicenses(
        organizationAndTeamData: OrganizationAndTeamData,
        userGitIds: string[],
        provider: string,
    ): Promise<{ revoked: string[]; failed: string[] }>;

    /**
     * Atomically consume one Kodus-funded trial review credit.
     *
     * @param organizationAndTeamData Organization ID and team ID.
     * @param usageKey Optional idempotency key for the reviewed PR.
     */
    consumeTrialReviewCredit(
        organizationAndTeamData: OrganizationAndTeamData,
        usageKey?: string,
    ): Promise<ConsumeTrialReviewCreditResult>;

    /**
     * Provision a Kodus-managed trial for the organization.
     *
     * Idempotent: the billing service returns 409 when a license already
     * exists, which is treated as success. Returns true when a trial is in
     * place after the call (created now or already present), false when it
     * could not be provisioned. Trials are a cloud-only concept.
     *
     * @param organizationAndTeamData Organization ID and team ID.
     * @param byok Whether the org connected its own AI key during onboarding.
     */
    startTrial(
        organizationAndTeamData: OrganizationAndTeamData,
        byok: boolean,
    ): Promise<boolean>;
}
