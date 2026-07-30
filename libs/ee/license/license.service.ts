import { createLogger } from '@libs/core/log/logger';

import { AxiosError } from 'axios';

import { AxiosLicenseService } from '@libs/core/infrastructure/config/axios/microservices/license.axios';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import {
    ConsumeTrialReviewCreditResult,
    ILicenseService,
    OrganizationLicenseValidationResult,
    UserWithLicense,
} from './interfaces/license.interface';

/**
 * LicenseService handles organization and user license validation via billing service endpoints.
 */
export class LicenseService implements ILicenseService {
    private readonly logger = createLogger(LicenseService.name);
    private readonly licenseRequest: AxiosLicenseService;

    constructor() {
        this.licenseRequest = new AxiosLicenseService();
    }

    /**
     * Validate organization license by calling the billing service endpoint.
     * @param organizationAndTeamData Organization and team identifiers
     * @returns Promise with license validation result
     */
    async validateOrganizationLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationLicenseValidationResult> {
        try {
            const response = await this.licenseRequest.get(
                'validate-org-license',
                {
                    params: {
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                    },
                },
            );

            return response;
        } catch (error) {
            this.logger.error({
                message: 'ValidateOrganizationLicense not working',
                context: LicenseService.name,
                error: error,
                serviceName: 'LicenseService validateOrganizationLicense',
                metadata: {
                    ...organizationAndTeamData,
                },
            });
            return { valid: false };
        }
    }

    /**
     * Provision a Kodus-managed trial for the organization via billing.
     *
     * The trial used to be created only by the browser at the end of
     * onboarding; if that client-side call never ran (tab closed, network
     * drop) or failed silently, the org was left without a license. This
     * server-side path makes provisioning reliable and retries transient
     * failures. The billing endpoint is idempotent (409 when a license
     * already exists), so repeating the call is safe.
     */
    async startTrial(
        organizationAndTeamData: OrganizationAndTeamData,
        byok: boolean,
    ): Promise<boolean> {
        const MAX_ATTEMPTS = 3;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                await this.licenseRequest.post('trial', {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    byok,
                });
                return true;
            } catch (error) {
                const status = (error as AxiosError)?.response?.status;

                // A license already exists — the trial is effectively in
                // place, so this is a success from our perspective.
                if (status === 409) {
                    return true;
                }

                // Client errors other than rate limiting won't be fixed by
                // retrying (bad payload, org not found, etc.).
                const isRetriable =
                    status === undefined || status === 429 || status >= 500;

                if (!isRetriable || attempt === MAX_ATTEMPTS) {
                    this.logger.error({
                        message: 'StartTrial failed to provision trial',
                        context: LicenseService.name,
                        error,
                        serviceName: 'LicenseService startTrial',
                        metadata: {
                            ...organizationAndTeamData,
                            byok,
                            attempt,
                            status,
                        },
                    });
                    return false;
                }

                // Exponential backoff before the next attempt.
                await new Promise((resolve) =>
                    setTimeout(resolve, 500 * 2 ** (attempt - 1)),
                );
            }
        }

        return false;
    }

    async consumeTrialReviewCredit(
        organizationAndTeamData: OrganizationAndTeamData,
        usageKey?: string,
    ): Promise<ConsumeTrialReviewCreditResult> {
        try {
            return await this.licenseRequest.post(
                'trial-review-credit/consume',
                {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    usageKey,
                },
            );
        } catch (error) {
            const responseData = (error as AxiosError)?.response
                ?.data as ConsumeTrialReviewCreditResult;

            if (responseData?.allowed === false) {
                return responseData;
            }

            this.logger.error({
                message: 'ConsumeTrialReviewCredit not working',
                context: LicenseService.name,
                error,
                serviceName: 'LicenseService consumeTrialReviewCredit',
                metadata: {
                    ...organizationAndTeamData,
                    usageKey,
                },
            });

            return {
                allowed: false,
                reason: 'CONSUME_TRIAL_REVIEW_CREDIT_FAILED',
            };
        }
    }

    /**
     * Get all users with license by calling the billing service endpoint.
     * @param organizationAndTeamData Organization and team identifiers
     * @returns Promise with array of users with license
     */
    async getAllUsersWithLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<UserWithLicense[]> {
        try {
            return await this.licenseRequest.get('users-with-license', {
                params: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'GetAllUsersWithLicense not working',
                error: error,
                context: LicenseService.name,
                serviceName: 'LicenseService getAllUsersWithLicense',
                metadata: {
                    ...organizationAndTeamData,
                },
            });
            return [];
        }
    }

    async getAllUsersEverWithLicense(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<UserWithLicense[]> {
        return this.getAllUsersWithLicense(organizationAndTeamData);
    }

    /**
     * Assign license to a user by calling the billing service endpoint.
     * @param organizationAndTeamData Organization and team identifiers
     * @param userGitId Git ID of the user
     * @param provider The git provider (e.g., 'github', 'gitlab')
     * @returns Promise with boolean indicating success
     */
    async assignLicense(
        organizationAndTeamData: OrganizationAndTeamData,
        userGitId: string,
        provider: string,
    ): Promise<boolean> {
        try {
            const result = await this.licenseRequest.post('assign-license', {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                users: [
                    {
                        gitId: userGitId,
                        gitTool: provider.toLowerCase(),
                        licenseStatus: 'active',
                    },
                ],
                editedBy: {
                    email: 'system@kodus.ai', // Or some system identifier
                },
                userName: 'System Auto-Assign',
            });

            if (result?.failed?.length > 0) {
                return false;
            }

            return true;
        } catch (error) {
            this.logger.error({
                message: 'AssignLicense not working',
                error: error,
                context: LicenseService.name,
                serviceName: 'LicenseService assignLicense',
                metadata: {
                    ...organizationAndTeamData,
                    userGitId,
                    provider,
                },
            });
            return false;
        }
    }
}
