import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PricingResolver } from '@libs/analytics/application/use-cases/usage/pricing-resolver';
import { SpendLimitConfigService } from '@libs/analytics/application/spend-limit/spend-limit-config.service';

import { validateBudget } from '../domain/budget-meter';
import { resolveScanModel, SCAN_NEEDS_BYOK_MESSAGE } from './scan-model';
import { STALE_SCAN_AFTER } from './get-security-scans.use-case';
import {
    SecurityScanBudget,
    SecurityScanRecord,
    SecurityScanStatus,
} from '../domain/security-scan.types';
import {
    ISecurityScanRepository,
    ScanRepositoryKey,
    SECURITY_SCAN_REPOSITORY_TOKEN,
} from '../infrastructure/security-scan.repository';

const ALREADY_RUNNING =
    'A security scan of this repository is already running.';

interface ConfiguredRepository {
    id: string;
    name: string;
    default_branch?: string;
    organizationName?: string;
    full_name?: string;
}

export interface StartSecurityScanInput {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId: string;
    budget: SecurityScanBudget;
    requestedBy?: { userId?: string; email?: string };
}

export const NO_CODE_INTEGRATION_MESSAGE =
    'This team has no active code management integration to scan the repository through.';

@Injectable()
export class StartSecurityScanUseCase {
    constructor(
        @Inject(SECURITY_SCAN_REPOSITORY_TOKEN)
        private readonly scans: ISecurityScanRepository,
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueue: IJobQueueService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly permissionValidationService: PermissionValidationService,
        private readonly codeManagementService: CodeManagementService,
        private readonly pricingResolver: PricingResolver,
        private readonly spendLimitConfig: SpendLimitConfigService,
    ) {}

    /** Open to every plan, free included, while the scan is in beta (#2451). */
    async execute(input: StartSecurityScanInput): Promise<SecurityScanRecord> {
        const orgTeam = input.organizationAndTeamData;

        const repositories =
            (await this.integrationConfigService.findIntegrationConfigFormatted<
                ConfiguredRepository[]
            >(IntegrationConfigKey.REPOSITORIES, orgTeam)) ?? [];
        const repository = repositories.find(
            (r) => String(r.id) === String(input.repositoryId),
        );
        if (!repository) {
            throw new NotFoundException(
                'This repository is not connected to the team.',
            );
        }

        const { model, rates } = await resolveScanModel({
            organizationAndTeamData: orgTeam,
            permissionValidationService: this.permissionValidationService,
            pricingResolver: this.pricingResolver,
            pricingOverrides: (await this.spendLimitConfig.getConfig(orgTeam))
                ?.modelPricing,
        });
        if (!model.slot) {
            throw new BadRequestException(SCAN_NEEDS_BYOK_MESSAGE);
        }
        const budgetError = validateBudget(input.budget, !!rates);
        if (budgetError) {
            throw new BadRequestException(budgetError);
        }

        // A failed lookup throws (a 5xx, worth retrying); only a confirmed
        // absence is the caller's to fix.
        const platform =
            await this.codeManagementService.findTypeIntegration(orgTeam);
        // The platform is half the repository's identity (an id is only
        // unique on it): without an active integration there is no knowing
        // which repository this is, nor a way to clone it.
        if (!platform) {
            throw new BadRequestException(NO_CODE_INTEGRATION_MESSAGE);
        }
        const repositoryKey = {
            platform: String(platform),
            id: String(repository.id),
        };

        await this.scans.failStale(orgTeam.organizationId, STALE_SCAN_AFTER);
        const active = await this.scans.findActive(
            orgTeam.organizationId,
            repositoryKey,
        );
        if (active) {
            throw new ConflictException(ALREADY_RUNNING);
        }

        const resumed = await this.resumablePlan(
            orgTeam.organizationId,
            repositoryKey,
        );
        const fullName =
            repository.full_name ||
            (repository.name.includes('/')
                ? repository.name
                : `${repository.organizationName ?? ''}/${repository.name}`);

        const scan = await this.scans
            .create({
                organizationId: orgTeam.organizationId,
                teamId: orgTeam.teamId,
                repository: {
                    id: repositoryKey.id,
                    name: repository.name,
                    fullName,
                    platform: repositoryKey.platform,
                    defaultBranch: repository.default_branch || 'main',
                },
                status: SecurityScanStatus.QUEUED,
                budget: {
                    ...(input.budget.maxUsd !== undefined && rates
                        ? { maxUsd: input.budget.maxUsd }
                        : {}),
                    ...(input.budget.maxTokens !== undefined
                        ? { maxTokens: input.budget.maxTokens }
                        : {}),
                },
                spend: { usd: 0, inputTokens: 0, outputTokens: 0, requests: 0 },
                units: resumed?.units ?? [],
                progress: resumed?.progress ?? [],
                ...(resumed && {
                    coverage: resumed.coverage,
                    planCommitSha: resumed.planCommitSha,
                    // The dedup compares against what the plan's finished
                    // areas found, and the job sights those issues.
                    reported: resumed.reported,
                }),
                modelName: model.modelName,
                requestedBy: input.requestedBy,
            })
            .catch(async (error) => {
                // Another request started one between the check above and
                // this write, and the one-active-scan index refused the
                // second: only a scan now active proves it, so read it back.
                if (
                    error?.code === 11000 &&
                    (await this.scans.findActive(
                        orgTeam.organizationId,
                        repositoryKey,
                    ))
                ) {
                    throw new ConflictException(ALREADY_RUNNING);
                }
                throw error;
            });

        try {
            await this.jobQueue.enqueue({
                correlationId: scan.uuid,
                workflowType: WorkflowType.SECURITY_SCAN,
                handlerType: HandlerType.SIMPLE_FUNCTION,
                payload: {
                    scanId: scan.uuid,
                    organizationAndTeamData: orgTeam,
                },
                organizationAndTeamData: orgTeam,
                status: JobStatus.PENDING,
                priority: 0,
                retryCount: 0,
                maxRetries: 2,
            });
        } catch (error) {
            // No job will ever run it: fail the record, which frees the
            // repository for the next start instead of holding it "running".
            await this.scans
                .update(scan.uuid, {
                    status: SecurityScanStatus.FAILED,
                    error: 'The scan could not be queued. Run it again.',
                    finishedAt: new Date().toISOString(),
                })
                .catch(() => undefined);
            throw error;
        }

        return scan;
    }

    /**
     * The plan of the repository's last scan when it stopped before the end
     * (its spend limit, or a stopped worker): running the scan again carries
     * on with the areas it had not reached instead of mapping the repository
     * from scratch and stopping at the same place. Areas already examined are
     * kept as done; their files are not counted as examined by the new scan,
     * so none of their findings is resolved for not being seen again.
     *
     * What the last scan reported is not carried: those issues were seen by
     * it, not by this one. A unit that finds one again stores it, which is
     * the sighting that keeps it open; the issue's own key keeps it one issue.
     * The plan is tied to the commit it was made at (`planCommitSha`): the
     * job drops it when the branch has moved since.
     */
    private async resumablePlan(
        organizationId: string,
        repository: ScanRepositoryKey,
    ): Promise<Pick<
        SecurityScanRecord,
        'units' | 'progress' | 'coverage' | 'planCommitSha' | 'reported'
    > | null> {
        const last = await this.scans.findLatest(organizationId, repository);
        // Stopped before the end, or completed with areas that failed (a
        // lens the provider refused): either way some areas were not read.
        const unfinished =
            last?.status === SecurityScanStatus.STOPPED_BY_BUDGET ||
            last?.status === SecurityScanStatus.FAILED ||
            (last?.status === SecurityScanStatus.COMPLETED &&
                (last.progress ?? []).some((p) => p.state === 'failed'));
        if (!last?.units?.length || !unfinished) {
            return null;
        }
        // Areas that failed (a provider outage) run again, with the rest.
        const progress = (last.progress ?? []).filter(
            (p) => p.state === 'done',
        );
        if (progress.length >= last.units.length) {
            return null;
        }
        return {
            units: last.units,
            progress,
            planCommitSha: last.commitSha,
            reported: last.reported ?? [],
            coverage: {
                examinedFiles: [],
                examinedByClass: [],
                unitsTotal: last.units.length,
                unitsDone: progress.length,
                unitsFailed: 0,
                unitsSkippedByBudget: 0,
                languages: last.coverage?.languages ?? [],
                // The same plan, with the same holes.
                mapFailedLanguages: last.coverage?.mapFailedLanguages ?? [],
                filesBeyondPlan: last.coverage?.filesBeyondPlan ?? 0,
            },
        };
    }
}
