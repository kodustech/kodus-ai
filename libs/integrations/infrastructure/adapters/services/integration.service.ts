import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationRepository,
    INTEGRATION_REPOSITORY_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.repository.contracts';
import {
    ConnectionRepositoryHint,
    IIntegrationService,
    ResolvedConnection,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { IntegrationEntity } from '@libs/integrations/domain/integrations/entities/integration.entity';
import { IIntegration } from '@libs/integrations/domain/integrations/interfaces/integration.interface';

@Injectable()
export class IntegrationService implements IIntegrationService {
    private readonly logger = createLogger(IntegrationService.name);

    constructor(
        @Inject(INTEGRATION_REPOSITORY_TOKEN)
        private readonly integrationRepository: IIntegrationRepository,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    async checkConfigIntegration(
        integrationId: string,
        integrationConfigKey: IntegrationConfigKey,
    ): Promise<boolean> {
        try {
            const integrationConfig =
                await this.integrationConfigService.findOne({
                    integration: { uuid: integrationId },
                    configKey: integrationConfigKey,
                });

            if (!integrationConfig) {
                return false;
            }

            return !!integrationConfig?.configValue || false;
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    async getPlatformIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{
        codeManagement: string;
    }> {
        try {
            const integrations = await this.find({
                organization: { uuid: organizationAndTeamData.organizationId },
                team: { uuid: organizationAndTeamData.teamId },
            });

            if (!integrations) {
                return {
                    codeManagement: null,
                };
            }

            const integrationPlatforms = {
                codeManagement: null,
            };

            for (const item of integrations) {
                if (
                    item?.integrationCategory.toUpperCase() ===
                    IntegrationCategory.CODE_MANAGEMENT
                ) {
                    integrationPlatforms.codeManagement = item?.platform;
                }
            }

            return integrationPlatforms;
        } catch (error) {
            throw new BadRequestException(error);
        }
    }

    getFullIntegrationDetails(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
    ): Promise<IntegrationEntity> {
        return this.integrationRepository.getFullIntegrationDetails(
            organizationAndTeamData,
            platform,
        );
    }

    find(filter?: Partial<IIntegration>): Promise<IntegrationEntity[]> {
        return this.integrationRepository.find(filter);
    }

    findOne(filter?: Partial<IIntegration>): Promise<IntegrationEntity> {
        return this.integrationRepository.findOne(filter);
    }

    findById(uuid: string): Promise<IntegrationEntity> {
        return this.integrationRepository.findById(uuid);
    }

    create(integration: IIntegration): Promise<IntegrationEntity> {
        return this.integrationRepository.create(integration);
    }

    update(
        filter: Partial<IIntegration>,
        data: Partial<IIntegration>,
    ): Promise<IntegrationEntity> {
        return this.integrationRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.integrationRepository.delete(uuid);
    }

    async getPlatformAuthDetails<T>(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
    ): Promise<T> {
        try {
            const integration = await this.findPlatformConnection(
                organizationAndTeamData,
                platform,
            );

            if (!integration) return null;

            const authDetails = integration?.authIntegration?.authDetails || {};

            if (!authDetails) {
                return null;
            }

            return {
                integrationId: integration?.uuid,
                ...authDetails,
                // Identity of the stored credential, without reading it: the
                // row id plus its last write. A rotated token rewrites the
                // row (new updatedAt), a reconnect creates a new one. Set after
                // the spread so a stored field can't shadow them.
                authIntegrationId: integration?.authIntegration?.uuid,
                authUpdatedAt: integration?.authIntegration?.updatedAt,
            } as T;
        } catch (error) {
            this.logger.error({
                message: 'Failed to get platform auth details',
                context: IntegrationService.name,
                error,
                metadata: { organizationAndTeamData, platform },
            });
        }
    }

    /**
     * The workspace's connection on `platform`. A named connection
     * (`integrationId`) wins; otherwise a workspace with several on the same
     * platform gets the first one, logged, until the caller names it.
     */
    private async findPlatformConnection(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
    ): Promise<IntegrationEntity | undefined> {
        const scope = {
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            platform,
        };

        if (organizationAndTeamData.integrationId) {
            return this.findOne({
                ...scope,
                uuid: organizationAndTeamData.integrationId,
            });
        }

        const candidates = (await this.find(scope)) ?? [];

        if (candidates.length > 1) {
            this.logger.warn({
                message: 'connection_ambiguous',
                context: IntegrationService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    platform,
                    candidateIds: candidates.map((c) => c.uuid),
                },
            });
        }

        return candidates[0];
    }

    async resolveCodeManagementConnection(
        organizationAndTeamData: OrganizationAndTeamData,
        hint: {
            platform?: PlatformType;
            repository?: ConnectionRepositoryHint;
        } = {},
    ): Promise<ResolvedConnection> {
        const scope = {
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
            integrationCategory: IntegrationCategory.CODE_MANAGEMENT,
            status: true,
        };

        if (organizationAndTeamData.integrationId) {
            const integration = await this.findOne({
                ...scope,
                uuid: organizationAndTeamData.integrationId,
                ...(hint.platform ? { platform: hint.platform } : {}),
            });
            return {
                integration,
                platform: integration?.platform ?? null,
                ambiguous: false,
            };
        }

        const all = (await this.find(scope)) ?? [];
        const candidates = hint.platform
            ? all.filter((c) => c.platform === hint.platform)
            : all;

        if (candidates.length <= 1) {
            return {
                integration: candidates[0],
                platform: candidates[0]?.platform ?? null,
                ambiguous: false,
            };
        }

        if (hint.repository) {
            const matches = await this.connectionsListingRepository(
                candidates,
                organizationAndTeamData,
                hint.repository,
            );
            if (matches.length === 1) {
                return {
                    integration: matches[0],
                    platform: matches[0].platform,
                    ambiguous: false,
                };
            }
        }

        this.logger.warn({
            message: 'connection_ambiguous',
            context: IntegrationService.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                platform: hint.platform,
                repository: hint.repository,
                candidateIds: candidates.map((c) => c.uuid),
            },
        });

        const platforms = new Set(candidates.map((c) => c.platform));
        return {
            integration: undefined,
            platform: platforms.size === 1 ? candidates[0].platform : null,
            ambiguous: true,
        };
    }

    private async connectionsListingRepository(
        candidates: IntegrationEntity[],
        organizationAndTeamData: OrganizationAndTeamData,
        repository: ConnectionRepositoryHint,
    ): Promise<IntegrationEntity[]> {
        const id = repository.id != null ? String(repository.id) : undefined;
        const lists = await Promise.allSettled(
            candidates.map((candidate) =>
                this.integrationConfigService.findOne({
                    integration: { uuid: candidate.uuid },
                    team: { uuid: organizationAndTeamData.teamId },
                    configKey: IntegrationConfigKey.REPOSITORIES,
                }),
            ),
        );

        return candidates.filter((_, index) => {
            const result = lists[index];
            if (result.status !== 'fulfilled') return false;
            const repos = Array.isArray(result.value?.configValue)
                ? (result.value.configValue as Array<{
                      id?: string | number;
                      name?: string;
                      full_name?: string;
                  }>)
                : [];
            return repos.some((repo) =>
                id !== undefined
                    ? String(repo?.id) === id
                    : repository.fullName
                      ? repo?.full_name === repository.fullName
                      : !!repository.name && repo?.name === repository.name,
            );
        });
    }
}
