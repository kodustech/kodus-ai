import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import { createLogger } from '@libs/core/log/logger';

import {
    IOrganizationParametersRepository,
    ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.repository.contract';
import { IOrganizationParametersService } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersEntity } from '@libs/organization/domain/organizationParameters/entities/organizationParameters.entity';
import { IOrganizationParameters } from '@libs/organization/domain/organizationParameters/interfaces/organizationParameters.interface';
import { OrganizationParametersKey } from '@libs/core/domain/enums/organization-parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BYOKConfig, isByokConfig } from '@libs/llm/byok-config';

@Injectable()
export class OrganizationParametersService implements IOrganizationParametersService {
    private readonly logger = createLogger(OrganizationParametersService.name);

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_REPOSITORY_TOKEN)
        private readonly organizationParametersRepository: IOrganizationParametersRepository,
    ) {}

    find(
        filter?: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity[]> {
        return this.organizationParametersRepository.find(filter);
    }

    findOne(
        filter?: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity> {
        return this.organizationParametersRepository.findOne(filter);
    }

    findByOrganizationName(
        organizationName: string,
    ): Promise<OrganizationParametersEntity> {
        return this.organizationParametersRepository.findByOrganizationName(
            organizationName,
        );
    }
    findById(uuid: string): Promise<OrganizationParametersEntity> {
        return this.organizationParametersRepository.findById(uuid);
    }

    create(
        parameters: IOrganizationParameters,
    ): Promise<OrganizationParametersEntity> {
        return this.organizationParametersRepository.create(parameters);
    }

    update(
        filter: Partial<IOrganizationParameters>,
        data: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity> {
        return this.organizationParametersRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.organizationParametersRepository.delete(uuid);
    }

    async findByKey(
        configKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity> {
        return this.organizationParametersRepository.findByKey(
            configKey,
            organizationAndTeamData,
        );
    }

    async createOrUpdateConfig(
        organizationParametersKey: OrganizationParametersKey,
        configValue: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity | boolean> {
        try {
            const organizationParameters = await this.findOne({
                organization: { uuid: organizationAndTeamData.organizationId },
                configKey: organizationParametersKey,
            });

            if (!organizationParameters) {
                const uuid = uuidv4();

                return await this.create({
                    uuid: uuid,
                    configKey: organizationParametersKey,
                    configValue: configValue,
                    organization: {
                        uuid: organizationAndTeamData.organizationId,
                    },
                });
            } else {
                await this.update(
                    {
                        uuid: organizationParameters?.uuid,
                        organization: {
                            uuid: organizationAndTeamData.organizationId,
                        },
                    },
                    {
                        configKey: organizationParametersKey,
                        configValue: configValue,
                        organization: {
                            uuid: organizationAndTeamData.organizationId,
                        },
                    },
                );
                return true;
            }
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    findByKeyAndValue(filter: {
        configKey: OrganizationParametersKey;
        configValue: any;
        organizationAndTeamData?: OrganizationAndTeamData;
        fuzzy?: boolean;
    }): Promise<OrganizationParametersEntity[]> {
        return this.organizationParametersRepository.findByKeyAndValue(filter);
    }

    async deleteByokConfig(
        organizationId: string,
        configType: 'main' | 'fallback',
    ): Promise<boolean> {
        try {
            // First, fetch current configuration
            const organizationAndTeamData = { organizationId };
            const currentConfig = await this.findByKey(
                OrganizationParametersKey.BYOK_CONFIG,
                organizationAndTeamData,
            );

            if (!currentConfig || !currentConfig.configValue) {
                throw new BadRequestException('BYOK configuration not found');
            }

            const configValue = currentConfig.configValue;

            if (!configValue[configType]) {
                throw new BadRequestException(`config ${configType} not found`);
            }

            // If deleting main and there is no fallback, or deleting fallback when only fallback exists
            if (configType === 'main' && !configValue.fallback) {
                // delete the entire configuration if there is only main
                await this.organizationParametersRepository.delete(
                    currentConfig.uuid,
                );
                return true;
            }

            // Create new configuration without the deleted part
            const newConfigValue = { ...configValue };
            delete newConfigValue[configType];

            // Update in repository
            const updatedConfig =
                await this.organizationParametersRepository.update(
                    { uuid: currentConfig.uuid },
                    { configValue: newConfigValue },
                );

            return !!updatedConfig;
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async deleteByokModel(
        organizationId: string,
        modelId: string,
    ): Promise<boolean> {
        try {
            const organizationAndTeamData = { organizationId };
            const currentConfig = await this.findByKey(
                OrganizationParametersKey.BYOK_CONFIG,
                organizationAndTeamData,
            );

            if (!currentConfig || !currentConfig.configValue) {
                throw new BadRequestException('BYOK configuration not found');
            }

            const configValue = currentConfig.configValue;

            if (!isByokConfig(configValue)) {
                throw new BadRequestException(
                    'Model-level delete requires a BYOK configuration',
                );
            }

            const models = configValue.models ?? [];
            const target = models.find((m) => m?.id === modelId);
            if (!target) {
                throw new BadRequestException(`model ${modelId} not found`);
            }

            const remainingModels = models.filter((m) => m?.id !== modelId);

            // Last-model disconnect: removing the final model tears down the
            // whole config rather than leaving an empty/invalid pool that would
            // break resolution (mirrors the legacy "only main → delete entire
            // config" branch above).
            if (remainingModels.length === 0) {
                await this.organizationParametersRepository.delete(
                    currentConfig.uuid,
                );
                return true;
            }

            // Drop a now-orphan, non-managed credential: one that no remaining
            // model references. A managed credential is always kept (env-default
            // path). Retained credentials carry their ciphertext verbatim — we
            // never touch or re-encrypt apiKey/aws* fields.
            const credentials = configValue.credentials ?? [];
            const stillReferenced = new Set(
                remainingModels
                    .map((m) => m?.credentialId)
                    .filter((id): id is string => !!id),
            );
            const remainingCredentials = credentials.filter(
                (c) => c?.managed || (c?.id && stillReferenced.has(c.id)),
            );

            const newConfigValue: BYOKConfig = {
                ...configValue,
                models: remainingModels,
                credentials: remainingCredentials,
            };

            const updatedConfig =
                await this.organizationParametersRepository.update(
                    { uuid: currentConfig.uuid },
                    { configValue: newConfigValue },
                );

            return !!updatedConfig;
        } catch (err) {
            throw new BadRequestException(err);
        }
    }
}
