import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { UserRequest } from '@/config/types/http/user-request.type';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { Repositories } from '@/core/domain/platformIntegrations/types/codeManagement/repositories.type';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class GetOrganizationLanguageUseCase implements IUseCase {
    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    async execute(params: {
        teamId: string;
        repositoryId?: string;
        sampleSize?: number;
    }): Promise<{ language: string | null }> {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException(
                'Organization UUID is missing in the request',
            );
        }

        if (!params?.teamId) {
            throw new BadRequestException('teamId is required');
        }

        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId,
            teamId: params.teamId,
        };

        const sampleSize = Math.min(
            Math.max(Number(params.sampleSize ?? 5) || 5, 1),
            10,
        );

        const platformType =
            await this.codeManagementService.getTypeIntegration(
                organizationAndTeamData,
            );

        let repositories = await this.getConfiguredRepositories(
            organizationAndTeamData,
        );

        if (!repositories?.length) {
            repositories = await this.safeListRepositoriesFromProvider(
                organizationAndTeamData,
            );
        }

        if (!repositories?.length) {
            return { language: null };
        }

        if (!platformType) {
            return { language: null };
        }

        const candidates = this.pickCandidateRepositories({
            repositories,
            repositoryId: params.repositoryId,
            sampleSize,
        });

        const languages = await Promise.all(
            candidates.map(async (repo) => {
                const existing = this.normalizeLanguage(
                    (repo as any)?.language,
                );
                if (existing) return existing;

                if (platformType === PlatformType.GITHUB) {
                    return null;
                }

                const id = (repo as any)?.id?.toString?.() ?? (repo as any)?.id;
                const name =
                    (repo as any)?.name?.toString?.() ?? (repo as any)?.name;

                if (!id || !name) return null;

                const fetched = await this.codeManagementService.getLanguageRepository(
                    {
                        organizationAndTeamData,
                        repository: { id: String(id), name: String(name) },
                    },
                );

                return this.normalizeLanguage(fetched);
            }),
        );

        let primary = this.pickMostCommonLanguage(languages);

        if (!primary && platformType === PlatformType.GITHUB) {
            const providerRepos = await this.safeListRepositoriesFromProvider(
                organizationAndTeamData,
            );

            if (providerRepos?.length) {
                const providerCandidates = this.pickCandidateRepositories({
                    repositories: providerRepos,
                    repositoryId: params.repositoryId,
                    sampleSize,
                });

                primary = this.pickMostCommonLanguage(
                    providerCandidates.map((r) =>
                        this.normalizeLanguage((r as any)?.language),
                    ),
                );
            }
        }

        return { language: primary };
    }

    private async getConfiguredRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<(Partial<Repositories> & Record<string, any>)[] | null> {
        try {
            const repos =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    any[]
                >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);

            if (!Array.isArray(repos) || repos.length === 0) return null;
            return repos;
        } catch (error) {
            this.logger.warn({
                message: 'Failed to read configured repositories',
                context: GetOrganizationLanguageUseCase.name,
                error,
                metadata: { organizationAndTeamData },
            });
            return null;
        }
    }

    private async safeListRepositoriesFromProvider(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<(Partial<Repositories> & Record<string, any>)[] | null> {
        try {
            const repos = await this.codeManagementService.getRepositories({
                organizationAndTeamData,
            });
            return repos?.length ? repos : null;
        } catch (error) {
            this.logger.warn({
                message: 'Failed to list repositories from provider',
                context: GetOrganizationLanguageUseCase.name,
                error,
                metadata: { organizationAndTeamData },
            });
            return null;
        }
    }

    private pickCandidateRepositories(params: {
        repositories: (Partial<Repositories> & Record<string, any>)[];
        repositoryId?: string;
        sampleSize: number;
    }): (Partial<Repositories> & Record<string, any>)[] {
        const { repositories, repositoryId, sampleSize } = params;

        if (repositoryId) {
            const match =
                repositories.find((r) => String((r as any)?.id) === repositoryId) ??
                repositories.find(
                    (r) => String((r as any)?.name) === repositoryId,
                );
            return match ? [match] : repositories.slice(0, 1);
        }

        const selected = repositories.filter(
            (r) => (r as any)?.selected === true || (r as any)?.isSelected === true,
        );

        return (selected.length ? selected : repositories).slice(0, sampleSize);
    }

    private normalizeLanguage(value: unknown): string | null {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }

    private pickMostCommonLanguage(values: Array<string | null>): string | null {
        const normalized = values.filter((v): v is string => !!v);
        if (!normalized.length) return null;

        const counts = new Map<string, number>();
        for (const lang of normalized) {
            counts.set(lang, (counts.get(lang) ?? 0) + 1);
        }

        let best: string | null = null;
        let bestCount = -1;
        for (const [lang, count] of counts.entries()) {
            if (count > bestCount) {
                best = lang;
                bestCount = count;
            }
        }

        return best;
    }
}
