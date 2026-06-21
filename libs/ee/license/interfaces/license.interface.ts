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
     * Atomically consume one Kodus-funded trial review credit.
     *
     * @param organizationAndTeamData Organization ID and team ID.
     * @param usageKey Optional idempotency key for the reviewed PR.
     */
    consumeTrialReviewCredit(
        organizationAndTeamData: OrganizationAndTeamData,
        usageKey?: string,
    ): Promise<ConsumeTrialReviewCreditResult>;
}
