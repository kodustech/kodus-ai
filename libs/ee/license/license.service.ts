import { createLogger } from '@kodus/flow';

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
