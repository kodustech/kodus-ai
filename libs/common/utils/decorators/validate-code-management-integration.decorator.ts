import { SimpleLogger } from '@libs/core/log/logger';

import { ConfigurationMissingException } from '@libs/core/infrastructure/filters/configuration-missing.exception';
import {
    CodeManagementConnectionStatus,
    ICodeManagementService,
} from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';

import { extractOrganizationAndTeamData } from './extractOrganizationAndTeamData.helper';

interface ValidateToolsManagementIntegrationOptions {
    allowPartialTeamConnection?: boolean;
    onlyCheckConnection?: boolean;
}

export function ValidateCodeManagementIntegration(
    options?: ValidateToolsManagementIntegrationOptions,
) {
    // Default value for checkConnectionByOneTeam is true
    const allowPartialTeamConnection =
        options?.allowPartialTeamConnection ?? false;
    const onlyCheckConnection = options?.onlyCheckConnection ?? false;
    return function (
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor,
    ) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: any[]) {
            const organizationAndTeamData =
                extractOrganizationAndTeamData(args);

            if (!allowPartialTeamConnection && !organizationAndTeamData) {
                throw new Error(
                    'organizationAndTeamData is required for Code Management integration validation.',
                );
            } else if (
                allowPartialTeamConnection &&
                !organizationAndTeamData?.organizationId
            ) {
                throw new Error(
                    'organizationId is required for Code Management integration validation when allowPartialTeamConnection is true.',
                );
            }

            // Access services via `this`
            const codeManagementService: ICodeManagementService =
                this.codeManagementService;
            const logger: SimpleLogger = this.logger;

            if (!codeManagementService || !logger) {
                throw new Error(
                    'codeManagementService and logger must be available on the class instance.',
                );
            }

            // Validation logic
            let verifyConnection: CodeManagementConnectionStatus;
            try {
                verifyConnection = await codeManagementService.verifyConnection(
                    {
                        organizationAndTeamData,
                    },
                );

                if (!onlyCheckConnection) {
                    if (!verifyConnection || !verifyConnection?.hasConnection) {
                        logger.warn({
                            message: 'Code Management not integrated',
                            context: target.constructor.name,
                            metadata: {
                                ...organizationAndTeamData,
                            },
                        });

                        throw new ConfigurationMissingException(
                            'Missing CODE_MANAGEMENT configuration',
                            'CONFIGURATION_MISSING',
                        );
                    }

                    if (
                        !allowPartialTeamConnection &&
                        !verifyConnection.isSetupComplete
                    ) {
                        logger.warn({
                            message: 'Repository not configured for the team',
                            context: target.constructor.name,
                            metadata: {
                                teamId: organizationAndTeamData?.teamId,
                                organizationId:
                                    organizationAndTeamData.organizationId,
                            },
                        });

                        throw new ConfigurationMissingException(
                            'No repository has been configured for this team.',
                            'REPOSITORY_CONFIGURATION_MISSING',
                        );
                    }
                }
            } catch (error) {
                logger.warn({
                    message: 'Error validating Code Management integration',
                    context: target.constructor.name,
                    error,
                    metadata: {
                        ...organizationAndTeamData,
                    },
                });
                throw error;
            }

            return originalMethod.apply(this, [...args, verifyConnection]);
        };

        return descriptor;
    };
}
