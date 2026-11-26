import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { isString } from 'class-validator';
import { v4 as uuidv4 } from 'uuid';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigRepository,
    INTEGRATION_CONFIG_REPOSITORY_TOKEN,
    OrganizationRepositoryList,
    RepositoryListing,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.repository.contracts';
import { IIntegrationConfigService } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigEntity } from '@libs/integrations/domain/integrationConfigs/entities/integration-config.entity';
import { IIntegrationConfig } from '@libs/integrations/domain/integrationConfigs/interfaces/integration-config.interface';
import { connectionServerKey } from '@libs/integrations/domain/integrations/utils/connection-host';

@Injectable()
export class IntegrationConfigService implements IIntegrationConfigService {
    constructor(
        @Inject(INTEGRATION_CONFIG_REPOSITORY_TOKEN)
        private readonly integrationConfigRepository: IIntegrationConfigRepository,
    ) {}

    savePrivateChannel(params: any): Promise<void> {
        return this.integrationConfigRepository.savePrivateChannel(params);
    }

    findOneIntegrationConfigWithIntegrations(
        configKey: IntegrationConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.findOneIntegrationConfigWithIntegrations(
            configKey,
            organizationAndTeamData,
        );
    }

    find(
        filter?: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity[]> {
        return this.integrationConfigRepository.find(filter);
    }

    findOne(
        filter?: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.findOne(filter);
    }

    findByOrganizationName(
        organizationName: string,
    ): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.findByOrganizationName(
            organizationName,
        );
    }

    findByInstallId(installId: string): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.findByInstallId(installId);
    }

    findByOrganizationAndConfigKey(
        organizationId: string,
        configKey: IntegrationConfigKey,
    ): Promise<IntegrationConfigEntity[]> {
        return this.integrationConfigRepository.findByOrganizationAndConfigKey(
            organizationId,
            configKey,
        );
    }

    findById(uuid: string): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.findById(uuid);
    }

    /**
     * Repository ids listed by another active Git connection of the
     * organization on the same server. Hooks and per-repository records
     * keyed by id stay while one of them still reviews the repository; the
     * same id on another server is another repository. When the connection
     * itself is not among them, every listed id counts.
     */
    async repositoryIdsListedByOtherConnections(
        organizationId: string,
        integrationId: string,
    ): Promise<Set<string>> {
        const lists =
            (await this.integrationConfigRepository.findRepositoryListsOfOrganization(
                organizationId,
            )) ?? [];
        const serverOf = (list: { platform: string; host?: string | null }) =>
            connectionServerKey(list.platform as PlatformType, {
                host: list.host,
            });
        const own = lists.find((list) => list.integrationId === integrationId);
        const server = own ? serverOf(own) : undefined;
        return new Set(
            lists
                .filter(
                    (list) =>
                        list.integrationId !== integrationId &&
                        (!server || serverOf(list) === server),
                )
                .flatMap((list) =>
                    Array.isArray(list.repositories) ? list.repositories : [],
                )
                .map((repository: { id: string | number }) =>
                    String(repository?.id),
                ),
        );
    }

    findRepositoryListings(params: {
        teamId: string;
        integrationIds: string[];
        repository: { id?: string | number; name?: string; fullName?: string };
    }): Promise<RepositoryListing[]> {
        return this.integrationConfigRepository.findRepositoryListings(params);
    }

    findRepositoryListsOfOrganization(
        organizationId: string,
    ): Promise<OrganizationRepositoryList[]> {
        return this.integrationConfigRepository.findRepositoryListsOfOrganization(
            organizationId,
        );
    }

    findAllOfTeamByConfigKey(
        configKey: IntegrationConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IntegrationConfigEntity[]> {
        return this.integrationConfigRepository.findAllOfTeamByConfigKey(
            configKey,
            organizationAndTeamData,
        );
    }

    findIntegrationConfigWithTeams(
        configKey: IntegrationConfigKey,
        repositoryId: string,
        platformType: PlatformType,
    ): Promise<IntegrationConfigEntity[]> {
        return this.integrationConfigRepository.findIntegrationConfigWithTeams(
            configKey,
            repositoryId,
            platformType,
        );
    }

    create(
        integrationConfig: IIntegrationConfig,
    ): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.create(integrationConfig);
    }

    update(
        filter: Partial<IIntegrationConfig>,
        data: Partial<IIntegrationConfig>,
    ): Promise<IntegrationConfigEntity> {
        return this.integrationConfigRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.integrationConfigRepository.delete(uuid);
    }

    async createOrUpdateConfig(
        integrationConfigKey: IntegrationConfigKey,
        payload: any,
        integrationId: any,
        organizationAndTeamData: OrganizationAndTeamData,
        type?: 'replace' | 'append',
    ): Promise<IntegrationConfigEntity> {
        try {
            if (!integrationId) {
                return null;
            }

            const integrationConfig = await this.findOne({
                integration: { uuid: integrationId },
                team: { uuid: organizationAndTeamData.teamId },
                configKey: integrationConfigKey,
            });

            // Implementing append logic for repositories
            if (
                type === 'append' &&
                integrationConfig?.configValue &&
                integrationConfigKey === IntegrationConfigKey.REPOSITORIES
            ) {
                const existingRepos = Array.isArray(
                    integrationConfig.configValue,
                )
                    ? integrationConfig.configValue
                    : [];
                const newRepos = Array.isArray(payload) ? payload : [];

                // Merge: existing repositories + new repositories, removing duplicates based on ID
                const mergedRepos = [...existingRepos];
                newRepos.forEach((newRepo) => {
                    if (
                        !existingRepos.find(
                            (existing) => existing.id === newRepo.id,
                        )
                    ) {
                        mergedRepos.push(newRepo);
                    }
                });

                payload = mergedRepos;
            }
            // For type "replace" or undefined: use payload directly (current behavior)

            if (!integrationConfig) {
                const uuid = uuidv4();

                return this.create({
                    uuid: uuid,
                    configKey: integrationConfigKey,
                    configValue: payload,
                    integration: { uuid: integrationId },
                    team: { uuid: organizationAndTeamData.teamId },
                });
            } else {
                return await this.update(
                    {
                        uuid: integrationConfig?.uuid,
                        team: { uuid: organizationAndTeamData.teamId },
                    },
                    {
                        configKey: integrationConfigKey,
                        configValue: payload,
                        integration: { uuid: integrationId },
                        team: { uuid: organizationAndTeamData.teamId },
                    },
                );
            }
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async findIntegrationConfigFormatted<T>(
        configKey: IntegrationConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<T> {
        try {
            // A workspace can hold several Git connections: with none named,
            // its repositories are every connection's together.
            if (
                configKey === IntegrationConfigKey.REPOSITORIES &&
                !organizationAndTeamData?.integrationId
            ) {
                const rows =
                    await this.integrationConfigRepository.findAllOfTeamByConfigKey(
                        configKey,
                        organizationAndTeamData,
                    );
                // No row at all is "no config"; saved empty lists are an empty list.
                if (!rows?.length) return null;
                return rows.flatMap((row) =>
                    Array.isArray(row?.configValue) ? row.configValue : [],
                ) as T;
            }

            const data = await this.findOneIntegrationConfigWithIntegrations(
                configKey,
                organizationAndTeamData,
            );

            if (!data?.configValue) {
                return null;
            }

            // Checks if the payload is an array and returns it as such
            if (Array.isArray(data.configValue)) {
                return [...data.configValue] as T;
            }

            if (isString(data.configValue)) {
                return data.configValue as T;
            }

            // If it's not an array, return it as an object
            return { ...data.configValue } as T;
        } catch (error) {
            console.log(error);
            throw error;
        }
    }
}
