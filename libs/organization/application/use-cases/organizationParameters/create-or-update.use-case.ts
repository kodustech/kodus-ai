import { BYOKConfig } from '@kodus/kodus-common/llm';
import { encrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@kodus/flow';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersEntity } from '@libs/organization/domain/organizationParameters/entities/organizationParameters.entity';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class CreateOrUpdateOrganizationParametersUseCase implements IUseCase {
    private readonly logger = createLogger(
        CreateOrUpdateOrganizationParametersUseCase.name,
    );
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    async execute(
        organizationParametersKey: OrganizationParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity | boolean> {
        try {
            const processedConfigValue = configValue;
            if (
                organizationParametersKey ===
                OrganizationParametersKey.BYOK_CONFIG
            ) {
                return await this.saveByokConfig(
                    organizationParametersKey,
                    configValue,
                    organizationAndTeamData,
                );
            }

            return await this.organizationParametersService.createOrUpdateConfig(
                organizationParametersKey,
                processedConfigValue,
                organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error creating or updating organization parameters',
                context: CreateOrUpdateOrganizationParametersUseCase.name,
                error: error,
                metadata: {
                    organizationParametersKey,
                    configValue,
                    organizationAndTeamData,
                },
            });
            throw new Error(
                'Error creating or updating organization parameters',
            );
        }
    }

    private async saveByokConfig(
        organizationParametersKey: OrganizationParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean> {
        const getConfigValue =
            await this.organizationParametersService.findByKey(
                organizationParametersKey,
                organizationAndTeamData,
            );

        const existingConfig = getConfigValue?.configValue as
            | BYOKConfig
            | undefined;

        let processedConfigValue = configValue;
        processedConfigValue = this.encryptByokConfigApiKey(
            configValue,
            existingConfig,
        );

        const mergedConfigValue = {
            ...existingConfig,
            ...processedConfigValue,
        };

        const result =
            await this.organizationParametersService.createOrUpdateConfig(
                organizationParametersKey,
                mergedConfigValue,
                organizationAndTeamData,
            );

        return !!result;
    }

    private encryptByokConfigApiKey(
        configValue: any,
        existingConfig?: BYOKConfig,
    ): BYOKConfig {
        if (!configValue || typeof configValue !== 'object') {
            throw new Error('Invalid BYOK config value');
        }

        const byokConfig = configValue as BYOKConfig;

        if (!byokConfig.main && !byokConfig.fallback) {
            throw new Error('At least main or fallback config is required');
        }

        let encryptedMain = null;
        if (byokConfig.main) {
            if (!byokConfig.main.apiKey && !existingConfig?.main?.apiKey) {
                throw new Error('apiKey is required for main BYOK config');
            }
            encryptedMain = {
                ...byokConfig.main,
                apiKey: byokConfig.main.apiKey
                    ? encrypt(byokConfig.main.apiKey)
                    : existingConfig!.main.apiKey,
            };
        }

        let encryptedFallback = null;
        if (byokConfig.fallback) {
            if (
                !byokConfig.fallback.apiKey &&
                !existingConfig?.fallback?.apiKey
            ) {
                throw new Error('apiKey is required for fallback BYOK config');
            }
            encryptedFallback = {
                ...byokConfig.fallback,
                apiKey: byokConfig.fallback.apiKey
                    ? encrypt(byokConfig.fallback.apiKey)
                    : existingConfig!.fallback!.apiKey,
            };
        }

        return {
            ...(encryptedMain && { main: encryptedMain }),
            ...(encryptedFallback && { fallback: encryptedFallback }),
        };
    }
}
