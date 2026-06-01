import { decrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@kodus/flow';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersEntity } from '@libs/organization/domain/organizationParameters/entities/organizationParameters.entity';
import { IOrganizationParameters } from '@libs/organization/domain/organizationParameters/interfaces/organizationParameters.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class FindByKeyOrganizationParametersUseCase implements IUseCase {
    private readonly logger = createLogger(
        FindByKeyOrganizationParametersUseCase.name,
    );
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async execute(
        organizationParametersKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IOrganizationParameters | null> {
        try {
            const parameter =
                await this.organizationParametersService.findByKey(
                    organizationParametersKey,
                    organizationAndTeamData,
                );

            if (!parameter) {
                return null;
            }

            // Process BYOK configuration by masking sensitive credential
            // fields (apiKey for non-Bedrock providers, awsBearerToken /
            // awsAccessKeyId / awsSecretAccessKey / awsSessionToken for
            // Bedrock). Bedrock configs have no apiKey, so the gating
            // check has to consider the AWS fields as well.
            if (
                organizationParametersKey ===
                OrganizationParametersKey.BYOK_CONFIG
            ) {
                const configValue = parameter.configValue;

                if (
                    configValue &&
                    typeof configValue === 'object' &&
                    (this.slotHasSecrets(configValue.main) ||
                        this.slotHasSecrets(configValue.fallback))
                ) {
                    try {
                        const processedConfig = { ...configValue };

                        if (configValue.main) {
                            processedConfig.main = this.maskSlotSecrets(
                                configValue.main,
                            );
                        } else {
                            processedConfig.main = null;
                        }

                        if (configValue.fallback) {
                            processedConfig.fallback = this.maskSlotSecrets(
                                configValue.fallback,
                            );
                        } else {
                            processedConfig.fallback = null;
                        }

                        return {
                            uuid: parameter.uuid,
                            configKey: parameter.configKey,
                            configValue: processedConfig,
                            organization: parameter.organization,
                        };
                    } catch (error) {
                        this.logger.error({
                            message: 'Error decrypting BYOK credentials',
                            context:
                                FindByKeyOrganizationParametersUseCase.name,
                            error: error,
                        });
                        // Return original value in case of decryption error
                        return this.getUpdatedParameters(parameter);
                    }
                }
            }

            const updatedParameters = this.getUpdatedParameters(parameter);

            return updatedParameters;
        } catch (error) {
            this.logger.error({
                message: 'Error finding organization parameters by key',
                context: FindByKeyOrganizationParametersUseCase.name,
                error: error,
                metadata: {
                    organizationParametersKey,
                    organizationAndTeamData,
                },
            });

            throw error;
        }
    }

    private getUpdatedParameters(parameter: OrganizationParametersEntity) {
        return {
            uuid: parameter.uuid,
            configKey: parameter.configKey,
            configValue: parameter.configValue,
            organization: parameter.organization,
        };
    }

    private maskApiKey(apiKey: string): string {
        if (apiKey.length <= 6) {
            return apiKey;
        }
        const firstTwo = apiKey.substring(0, 2);
        const lastThree = apiKey.substring(apiKey.length - 3);
        return `${firstTwo}...${lastThree}`;
    }

    /**
     * Names of the encrypted credential fields on a BYOK slot. apiKey
     * covers OpenAI/Anthropic/Gemini/OpenRouter/Novita/Vertex (SA JSON);
     * the aws* fields cover Amazon Bedrock's two auth paths.
     */
    private static readonly SECRET_FIELDS = [
        'apiKey',
        'awsBearerToken',
        'awsAccessKeyId',
        'awsSecretAccessKey',
        'awsSessionToken',
    ] as const;

    private slotHasSecrets(slot: any): boolean {
        if (!slot || typeof slot !== 'object') return false;
        return FindByKeyOrganizationParametersUseCase.SECRET_FIELDS.some(
            (field) => typeof slot[field] === 'string' && slot[field],
        );
    }

    private maskSlotSecrets(slot: any): any {
        const masked: Record<string, any> = { ...slot };
        for (const field of FindByKeyOrganizationParametersUseCase.SECRET_FIELDS) {
            const value = slot[field];
            if (typeof value === 'string' && value) {
                masked[field] = this.maskApiKey(decrypt(value));
            }
        }
        return masked;
    }
}
