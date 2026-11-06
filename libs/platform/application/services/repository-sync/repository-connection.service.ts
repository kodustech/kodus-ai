import { Inject, Injectable } from '@nestjs/common';

import {
    IRepositoryService,
    REPOSITORY_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryService.contract';
import {
    AstGraphStatus,
    RepositoryModel,
} from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { BackfillHistoricalPRsUseCase } from '@libs/platformData/application/use-cases/pullRequests/backfill-historical-prs.use-case';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

/** An AST job queued longer than this is treated as lost, not in flight. */
const AST_IN_FLIGHT_WINDOW_MS = 3 * 60 * 60 * 1000;

// Teams with a history backfill in flight. Per process: the backfill runs in
// the process that started it, and a second one over the same repositories
// only doubles the provider load (the burst that 429s Bitbucket).
const backfillInFlight = new Set<string>();

type ConnectableRepository = Pick<Repositories, 'id' | 'name'> &
    Partial<
        Pick<
            Repositories,
            'full_name' | 'organizationName' | 'http_url' | 'default_branch'
        >
    > & { fullName?: string };

/**
 * What connecting a repository to Kodus involves besides its webhook: the
 * repository record, the AST graph build and the history backfill. Shared by
 * a manual selection save and the automatic sync, and free of request scope
 * so the cron can use it.
 */
@Injectable()
export class RepositoryConnectionService {
    private readonly logger = createLogger(RepositoryConnectionService.name);

    constructor(
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueueService: IJobQueueService,
        @Inject(REPOSITORY_SERVICE_TOKEN)
        private readonly repositoryService: IRepositoryService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly backfillHistoricalPRsUseCase: BackfillHistoricalPRsUseCase,
        private readonly telemetry: TelemetryService,
    ) {}

    static fullNameOf(repository: ConnectableRepository): string {
        const name = repository.name || '';
        return (
            repository.fullName ||
            repository.full_name ||
            (name.includes('/')
                ? name
                : `${repository.organizationName || ''}/${name}`)
        );
    }

    /**
     * Finds or creates the repository record of each repository. The record
     * points at the team's REPOSITORIES config row, which is what the AST
     * tooling joins on (#2100: the team id was written here before).
     */
    async registerRepositoryRecords(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        platform: string;
        repositories: ConnectableRepository[];
        actorUserId?: string;
    }): Promise<
        Array<{ repository: ConnectableRepository; record: RepositoryModel }>
    > {
        const { organizationAndTeamData, platform, repositories, actorUserId } =
            params;

        if (!repositories?.length) {
            return [];
        }

        const repositoriesConfig = await this.integrationConfigService.findOne({
            team: { uuid: organizationAndTeamData.teamId },
            configKey: IntegrationConfigKey.REPOSITORIES,
        });

        if (!repositoriesConfig?.uuid) {
            this.logger.warn({
                message:
                    'No repositories config row for the team; repository records not created',
                context: RepositoryConnectionService.name,
                metadata: {
                    organizationAndTeamData,
                    repositoryCount: repositories.length,
                },
            });
            return [];
        }

        const registered: Array<{
            repository: ConnectableRepository;
            record: RepositoryModel;
        }> = [];

        for (const repository of repositories) {
            try {
                const record = await this.repositoryService.findOrCreate({
                    integrationConfigId: repositoriesConfig.uuid,
                    externalId: String(repository.id),
                    name: repository.name,
                    fullName: RepositoryConnectionService.fullNameOf(repository),
                    platform,
                    defaultBranch: repository.default_branch,
                });

                void this.telemetry.repositoryConnected({
                    repositoryId: record.externalId,
                    name: record.name,
                    fullName: record.fullName,
                    platform: record.platform,
                    organizationId: organizationAndTeamData.organizationId,
                    agentReviewEnabled: true,
                    actorUserId,
                });

                registered.push({ repository, record });
            } catch (error) {
                this.logger.error({
                    message: 'Failed to register the repository record',
                    context: RepositoryConnectionService.name,
                    error,
                    metadata: {
                        organizationAndTeamData,
                        repositoryId: repository.id,
                    },
                });
            }
        }

        return registered;
    }

    findRepositoryRecord(
        platform: string,
        externalId: string,
    ): Promise<RepositoryModel | null> {
        return this.repositoryService.findByExternalId(platform, externalId);
    }

    /** Enqueues a full AST build unless the graph is ready or building. */
    async enqueueAstBuild(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        record: RepositoryModel;
        cloneUrl?: string;
    }): Promise<boolean> {
        const { organizationAndTeamData, record, cloneUrl } = params;

        if (
            record.astGraphStatus !== AstGraphStatus.PENDING &&
            record.astGraphStatus !== AstGraphStatus.FAILED
        ) {
            return false;
        }

        await this.jobQueueService.enqueue({
            correlationId: organizationAndTeamData.teamId,
            workflowType: WorkflowType.AST_GRAPH_BUILD,
            handlerType: HandlerType.SIMPLE_FUNCTION,
            payload: {
                repositoryId: record.uuid,
                cloneUrl: cloneUrl || '',
                defaultBranch: record.defaultBranch,
                fullName: record.fullName,
                platform: record.platform,
                organizationAndTeamData,
            },
            organizationAndTeamData,
            status: JobStatus.PENDING,
            priority: 0,
            retryCount: 0,
            maxRetries: 3,
        });

        this.logger.log({
            message: `[AST-GRAPH] Enqueued full build for ${record.fullName}`,
            context: RepositoryConnectionService.name,
            metadata: { organizationAndTeamData, repositoryId: record.uuid },
        });

        return true;
    }

    /**
     * AST builds of this team that are queued or running. The build queue is
     * shared by every customer, so the sync keeps a team's share small.
     */
    async countInFlightAstBuilds(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<number> {
        const since = Date.now() - AST_IN_FLIGHT_WINDOW_MS;

        const pages = await Promise.all(
            [JobStatus.PENDING, JobStatus.PROCESSING].map((status) =>
                this.jobQueueService.listJobs({
                    status,
                    workflowType: WorkflowType.AST_GRAPH_BUILD,
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    limit: 100,
                }),
            ),
        );

        return pages
            .flatMap((page) => page?.data ?? [])
            .filter((job) => {
                const createdAt = job?.createdAt
                    ? new Date(job.createdAt).getTime()
                    : NaN;
                return Number.isFinite(createdAt) && createdAt >= since;
            }).length;
    }

    /**
     * Starts the history backfill for these repositories in the background.
     * False when one is already running for the team.
     */
    startHistoricalBackfill(
        organizationAndTeamData: OrganizationAndTeamData,
        repositories: ConnectableRepository[],
    ): boolean {
        if (!repositories?.length) {
            return false;
        }

        const key = `${organizationAndTeamData.organizationId}:${organizationAndTeamData.teamId}`;

        if (backfillInFlight.has(key)) {
            this.logger.log({
                message:
                    'Skipping PR backfill — one is already in flight for this org/team',
                context: RepositoryConnectionService.name,
                metadata: { organizationAndTeamData },
            });
            return false;
        }

        backfillInFlight.add(key);

        void this.backfillHistoricalPRsUseCase
            .execute({
                organizationAndTeamData,
                repositories: repositories.map((repository) => ({
                    id: String(repository.id),
                    name: repository.name,
                    fullName: RepositoryConnectionService.fullNameOf(repository),
                    url: repository.http_url || '',
                })),
            })
            .catch((error) => {
                this.logger.error({
                    message: `Error during automatic PR backfill: ${error?.message || String(error)}`,
                    context: RepositoryConnectionService.name,
                    error,
                    metadata: { organizationAndTeamData },
                });
            })
            .finally(() => backfillInFlight.delete(key));

        return true;
    }
}
