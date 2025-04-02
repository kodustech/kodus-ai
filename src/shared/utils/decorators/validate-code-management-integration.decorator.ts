import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { ConfigurationMissingException } from '@/shared/infrastructure/filters/configuration-missing.exception';
import { extractOrganizationAndTeamData } from './extractOrganizationAndTeamData.helper';

export type CodeManagementConnectionStatus = {
    hasConnection: boolean; // Whether there is a connection with the tool (e.g., GitHub)
    isSetupComplete: boolean; // Whether the tool is configured (e.g., repositories)
    config?: object;
    platformName: string;
    category?: IntegrationCategory;
};

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
            const codeManagementService: CodeManagementService =
                this.codeManagementService;
            const logger: PinoLoggerService = this.logger;

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

            // Call the original method with the original arguments
            return originalMethod.apply(this, [...args, verifyConnection]);
        };

        return descriptor;
    };
}
