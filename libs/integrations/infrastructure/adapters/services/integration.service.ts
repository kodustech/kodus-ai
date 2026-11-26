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
import {
    recordedNameMatches,
    repositoryNamesOf,
} from '@libs/integrations/domain/integrations/utils/repository-names';

/** Long enough for one request or cron step, short enough to see a reset. */
const RESOLUTION_MEMO_TTL_MS = 5_000;
const RESOLUTION_MEMO_MAX = 5_000;

@Injectable()
export class IntegrationService implements IIntegrationService {
    private readonly logger = createLogger(IntegrationService.name);
    private readonly resolutions = new Map<
        string,
        { answer: Promise<ResolvedConnection>; expiresAt: number }
    >();

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

    /**
     * The connection a provider's connect call rewrites: the one named; none
     * when the caller adds a new one; else the workspace's only active
     * connection of the platform (its oldest inactive one when none is
     * active). With several active and none named it refuses: a connect that
     * lost its intent would otherwise rewrite the oldest one's credentials.
     */
    async connectionToUpdate(
        organizationAndTeamData: OrganizationAndTeamData,
        platform: PlatformType,
        newConnection?: boolean,
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
        if (newConnection) return undefined;

        const connections = (await this.find(scope)) ?? [];
        const active = connections.filter((connection) => connection.status);
        if (active.length > 1) {
            this.logger.warn({
                message: 'connection_to_update_ambiguous',
                context: IntegrationService.name,
                metadata: {
                    ...organizationAndTeamData,
                    platform,
                    connections: active.length,
                },
            });
            throw new BadRequestException(
                'This workspace has several connections to this provider: reconnect one from its card in Settings > Git.',
            );
        }
        return active[0] ?? connections[0];
    }

    // A write changes which connection answers; this process forgets its
    // answers at once, others within the memo's few seconds.
    async create(integration: IIntegration): Promise<IntegrationEntity> {
        try {
            return await this.integrationRepository.create(integration);
        } finally {
            this.resolutions.clear();
        }
    }

    async update(
        filter: Partial<IIntegration>,
        data: Partial<IIntegration>,
    ): Promise<IntegrationEntity> {
        try {
            return await this.integrationRepository.update(filter, data);
        } finally {
            this.resolutions.clear();
        }
    }

    async delete(uuid: string): Promise<void> {
        try {
            return await this.integrationRepository.delete(uuid);
        } finally {
            this.resolutions.clear();
        }
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
     * (`integrationId`) wins; otherwise the platform's only active connection
     * (or only row). Several and none named answers nothing, logged, so no
     * call runs with another connection's credentials.
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

        const rows = (await this.find(scope)) ?? [];
        const active = rows.filter((row) => row.status !== false);
        const candidates = active.length ? active : rows;

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
            return undefined;
        }

        return candidates[0];
    }

    /**
     * Which connection a call is for. The same question asked again within a
     * few seconds (a cron walking a PR, one request routing several calls)
     * gets the same answer without new queries.
     */
    resolveCodeManagementConnection(
        organizationAndTeamData: OrganizationAndTeamData,
        hint: {
            platform?: PlatformType;
            repository?: ConnectionRepositoryHint;
        } = {},
    ): Promise<ResolvedConnection> {
        const key = JSON.stringify([
            organizationAndTeamData?.organizationId,
            organizationAndTeamData?.teamId,
            organizationAndTeamData?.integrationId,
            hint.platform,
            hint.repository?.id != null ? String(hint.repository.id) : null,
            hint.repository?.fullName ?? null,
            hint.repository?.name ?? null,
        ]);
        const now = Date.now();
        const cached = this.resolutions.get(key);
        if (cached && cached.expiresAt > now) return cached.answer;

        if (this.resolutions.size >= RESOLUTION_MEMO_MAX) {
            for (const [entry, value] of this.resolutions) {
                if (value.expiresAt <= now) this.resolutions.delete(entry);
            }
            if (this.resolutions.size >= RESOLUTION_MEMO_MAX) {
                this.resolutions.clear();
            }
        }

        const answer = this.resolveConnection(organizationAndTeamData, hint);
        this.resolutions.set(key, {
            answer,
            expiresAt: now + RESOLUTION_MEMO_TTL_MS,
        });
        answer.catch(() => this.resolutions.delete(key));
        return answer;
    }

    private async resolveConnection(
        organizationAndTeamData: OrganizationAndTeamData,
        hint: {
            platform?: PlatformType;
            repository?: ConnectionRepositoryHint;
        },
    ): Promise<ResolvedConnection> {
        // No workspace, no lookup: an unscoped query would read every
        // organization's (or team's) connections.
        if (
            !organizationAndTeamData?.organizationId ||
            !organizationAndTeamData?.teamId
        ) {
            return { integration: undefined, platform: null, ambiguous: false };
        }

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

    /**
     * The candidates whose repository list holds the repository. A repository
     * id listed by several (ids repeat across servers) is settled by its full
     * name when the hint carries one.
     */
    private async connectionsListingRepository(
        candidates: IntegrationEntity[],
        organizationAndTeamData: OrganizationAndTeamData,
        repository: ConnectionRepositoryHint,
    ): Promise<IntegrationEntity[]> {
        const listings =
            (await this.integrationConfigService.findRepositoryListings({
                teamId: organizationAndTeamData.teamId,
                integrationIds: candidates.map((candidate) => candidate.uuid),
                repository,
            })) ?? [];

        let matched = new Set(listings.map((listing) => listing.integrationId));
        const fullName = repository.fullName;
        if (matched.size > 1 && fullName) {
            const byFullName = new Set(
                listings
                    .filter(
                        (listing) =>
                            recordedNameMatches(
                                repositoryNamesOf(listing.repository),
                                fullName,
                            ) === true,
                    )
                    .map((listing) => listing.integrationId),
            );
            if (byFullName.size) matched = byFullName;
        }

        return candidates.filter((candidate) => matched.has(candidate.uuid));
    }
}
