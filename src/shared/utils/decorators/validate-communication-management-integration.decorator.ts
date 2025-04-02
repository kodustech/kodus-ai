import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { ConfigurationMissingException } from '@/shared/infrastructure/filters/configuration-missing.exception';
import { extractOrganizationAndTeamData } from './extractOrganizationAndTeamData.helper';

export type CommunicationManagementConnectionStatus = {
    hasConnection: boolean; // Whether there is a connection with the tool (e.g., Slack)
    isSetupComplete: boolean; // Whether the tool is configured (e.g., channels)
    config?: object;
    platformName: string;
    category?: IntegrationCategory;
};

interface ValidateToolsManagementIntegrationOptions {
    allowPartialTeamConnection?: boolean;
    onlyCheckConnection?: boolean;
}
export function ValidateCommunicationManagementIntegration(
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
            // Extract organizationAndTeamData from arguments
            const organizationAndTeamData =
                extractOrganizationAndTeamData(args);

            if (!allowPartialTeamConnection && !organizationAndTeamData) {
                throw new Error(
                    'organizationAndTeamData is required for Communication Management integration validation.',
                );
            } else if (
                allowPartialTeamConnection &&
                !organizationAndTeamData?.organizationId
            ) {
                throw new Error(
                    'organizationId is required for Communication Management integration validation when allowPartialTeamConnection is true.',
                );
            }

            // Access services via `this`
            const communicationManagementService: CommunicationService =
                this.communicationService;
            const logger: PinoLoggerService = this.logger;
            if (!communicationManagementService || !logger) {
                throw new Error(
                    'CommunicationManagementService and logger must be available on the class instance.',
                );
            }
            // Validation logic
            let verifyConnection: CommunicationManagementConnectionStatus;
            try {
                verifyConnection =
                    await communicationManagementService.verifyConnection({
                        organizationAndTeamData,
                    });
                if (!onlyCheckConnection) {
                    if (!verifyConnection || !verifyConnection.hasConnection) {
                        logger.warn({
                            message: 'Communication Management not integrated',
                            context: target.constructor.name,
                            metadata: {
                                teamId: organizationAndTeamData.teamId,
                                organizationId:
                                    organizationAndTeamData.organizationId,
                            },
                        });
                        throw new ConfigurationMissingException(
                            'COMMUNICATION_MANAGEMENT configuration is missing',
                            'CONFIGURATION_MISSING',
                        );
                    }
                    if (
                        !allowPartialTeamConnection &&
                        !verifyConnection.isSetupComplete
                    ) {
                        logger.warn({
                            message: 'Channel not configured for the team',
                            context: target.constructor.name,
                            metadata: {
                                teamId: organizationAndTeamData.teamId,
                                organizationId:
                                    organizationAndTeamData.organizationId,
                            },
                        });
                        throw new ConfigurationMissingException(
                            'No channel has been configured for this team.',
                            'CHANNEL_CONFIGURATION_MISSING',
                        );
                    }
                }
            } catch (error) {
                logger.warn({
                    message:
                        'Error validating Communication Management integration',
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
