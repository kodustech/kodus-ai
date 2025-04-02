import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { ConfigurationMissingException } from '@/shared/infrastructure/filters/configuration-missing.exception';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { extractOrganizationAndTeamData } from './extractOrganizationAndTeamData.helper';

export type ProjectManagementConnectionStatus = {
    hasConnection: boolean; // Whether there is a connection with the tool (e.g., Jira)
    isSetupComplete: boolean; // Whether the tool is configured (e.g., boards, columns)
    config?: object;
    platformName: string;
    category?: IntegrationCategory;
};

interface ValidateToolsManagementIntegrationOptions {
    allowPartialTeamConnection?: boolean;
    onlyCheckConnection?: boolean;
}
export function ValidateProjectManagementIntegration(
    options?: ValidateToolsManagementIntegrationOptions,
) {
    // Default value for allowPartialTeamConnection is false
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
                    'organizationAndTeamData is required for validating Project Management integration.',
                );
            } else if (
                allowPartialTeamConnection &&
                !organizationAndTeamData?.organizationId
            ) {
                throw new Error(
                    'organizationId is required for validating Project Management integration when allowPartialTeamConnection is true.',
                );
            }

            // Access services via `this`
            const projectManagementService: ProjectManagementService =
                this.projectManagementService;
            const logger: PinoLoggerService = this.logger;
            if (!projectManagementService || !logger) {
                throw new Error(
                    'ProjectManagementService and logger must be available on the class instance.',
                );
            }

            let verifyConnection: ProjectManagementConnectionStatus;
            try {
                verifyConnection =
                    await projectManagementService.verifyConnection({
                        organizationAndTeamData,
                    });

                if (!onlyCheckConnection) {
                    if (!verifyConnection || !verifyConnection.hasConnection) {
                        logger.warn({
                            message: 'Project Management not integrated',
                            context: target.constructor.name,
                            metadata: {
                                teamId: organizationAndTeamData.teamId,
                                organizationId:
                                    organizationAndTeamData.organizationId,
                            },
                        });
                        throw new ConfigurationMissingException(
                            'Missing PROJECT_MANAGEMENT configuration',
                            'CONFIGURATION_MISSING',
                        );
                    }
                    if (
                        !allowPartialTeamConnection &&
                        !verifyConnection.isSetupComplete
                    ) {
                        logger.warn({
                            message: 'Board not configured for the team',
                            context: target.constructor.name,
                            metadata: {
                                teamId: organizationAndTeamData.teamId,
                                organizationId:
                                    organizationAndTeamData.organizationId,
                            },
                        });
                        throw new ConfigurationMissingException(
                            'No Board has been configured for this team.',
                            'BOARD_CONFIGURATION_MISSING',
                        );
                    }
                }
            } catch (error) {
                logger.warn({
                    message: 'Error validating Project Management integration',
                    context: target.constructor.name,
                    error,
                    metadata: {
                        teamId: organizationAndTeamData.teamId,
                        organizationId: organizationAndTeamData.organizationId,
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
