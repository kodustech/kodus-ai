import {
    BadRequestException,
    ConflictException,
    HttpException,
    HttpStatus,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
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

import {
    normalizeScanPath,
    repositoryHost,
} from '@libs/issues/domain/scan-fingerprint';

import { validateBudget } from '../domain/budget-meter';
import { boundedEnvInt } from '../domain/env-limits';
import type { SecurityScanMode } from '../domain/coverage-ledger';
import type { VulnClass } from '../domain/surface/surface.types';
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
import {
    ISecurityScanQueueProbe,
    SECURITY_SCAN_QUEUE_PROBE_TOKEN,
} from '../infrastructure/security-scan-queue.probe';

const ALREADY_RUNNING =
    'A security scan of this repository is already running. Cancel it to start another.';

interface ConfiguredRepository {
    id: string;
    name: string;
    default_branch?: string;
    organizationName?: string;
    full_name?: string;
    /** The repository's URL on its instance (see repositoryHost). */
    http_url?: string;
}

export interface StartSecurityScanInput {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId: string;
    budget: SecurityScanBudget;
    requestedBy?: { userId?: string; email?: string };
    /**
     * `incremental` (the default) reads only what changed since an earlier
     * scan's conclusions, or was never read; `full` reads everything again.
     */
    mode?: SecurityScanMode;
    /** A model of the organization's BYOK config to run this scan on. */
    modelId?: string;
    /** The schedule starting it, when one does. */
    scheduleId?: string;
}

export const SCAN_MODEL_NOT_FOUND_MESSAGE =
    'The model picked for this scan is not in your AI providers any more. Pick another, or leave it to the Deep scan routing.';

export const DEFAULT_BRANCH_UNREADABLE_MESSAGE =
    "Could not read the repository's default branch from its Git provider. Try again in a moment.";

export const NO_DEFAULT_BRANCH_MESSAGE =
    "The repository's Git provider gave no default branch. If the repository is empty, push to it or set its main branch on the provider; otherwise try again in a moment.";

export const NO_CODE_INTEGRATION_MESSAGE =
    'This team has no active code management integration to scan the repository through.';

/** Scans one organization may have queued or running at once. */
export const MAX_ACTIVE_SCANS_PER_ORGANIZATION = boundedEnvInt(
    'API_SECURITY_SCAN_MAX_ACTIVE_PER_ORG',
    3,
    1,
    100,
);

export const TOO_MANY_ACTIVE_SCANS_MESSAGE = `This organization already has ${MAX_ACTIVE_SCANS_PER_ORGANIZATION} deep scans queued or running. Start this one when one of them finishes, or schedule it.`;

export const SCAN_QUEUE_UNAVAILABLE_MESSAGE =
    'The deep scan worker is not taking jobs right now. Try again in a moment.';

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
        @Inject(SECURITY_SCAN_QUEUE_PROBE_TOKEN)
        private readonly queueProbe: ISecurityScanQueueProbe,
    ) {}

    /**
     * The model a scan runs on and its rates, refused as a start would refuse
     * it: no BYOK model, a picked model that is gone, or a limit the model
     * cannot be held to (USD for a model without a known price). A schedule
     * checks this when saved, so its runs do not fail on it later.
     */
    async scanModelFor(
        orgTeam: OrganizationAndTeamData,
        budget: SecurityScanBudget,
        modelId?: string,
    ) {
        const { model, rates } = await resolveScanModel({
            organizationAndTeamData: orgTeam,
            permissionValidationService: this.permissionValidationService,
            pricingResolver: this.pricingResolver,
            pricingOverrides: (await this.spendLimitConfig.getConfig(orgTeam))
                ?.modelPricing,
            modelId,
        });
        if (!model.slot) {
            throw new BadRequestException(SCAN_NEEDS_BYOK_MESSAGE);
        }
        // A picked model that is gone resolves to the routing's: said, not
        // silently run on another model.
        if (modelId && model.slot.byokModelId !== modelId) {
            throw new BadRequestException(SCAN_MODEL_NOT_FOUND_MESSAGE);
        }
        const budgetError = validateBudget(budget, !!rates);
        if (budgetError) {
            throw new BadRequestException(budgetError);
        }
        return { model, rates };
    }

    /** Open to every plan, free included, while the scan is in beta (#2451). */
    async execute(input: StartSecurityScanInput): Promise<SecurityScanRecord> {
        const orgTeam = input.organizationAndTeamData;

        const repository = await this.configuredRepository(
            orgTeam,
            input.repositoryId,
        );

        const { model, rates } = await this.scanModelFor(
            orgTeam,
            input.budget,
            input.modelId,
        );

        const { platform, repositoryKey } = await this.keyOf(
            orgTeam,
            repository,
        );

        await this.assertQueueAvailable();

        await this.scans.failStale(orgTeam.organizationId, STALE_SCAN_AFTER);
        const active = await this.scans.findActive(
            orgTeam.organizationId,
            repositoryKey,
        );
        if (active) {
            throw new ConflictException(ALREADY_RUNNING);
        }
        // One organization's scans take a bounded share of the scan workers.
        if (
            (await this.scans.countActive(orgTeam.organizationId)) >=
            MAX_ACTIVE_SCANS_PER_ORGANIZATION
        ) {
            throw new HttpException(
                TOO_MANY_ACTIVE_SCANS_MESSAGE,
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        // A scan asked to read everything again, or one on another model,
        // starts its own plan: carrying on would keep the areas the last
        // scan's model already concluded.
        const resumed =
            input.mode === 'full'
                ? null
                : await this.resumablePlan(
                      orgTeam.organizationId,
                      repositoryKey,
                      model.modelName,
                  );
        const fullName =
            repository.full_name ||
            (repository.name.includes('/')
                ? repository.name
                : `${repository.organizationName ?? ''}/${repository.name}`);
        // The branch the provider serves as default now: the one stored when
        // the repository was connected can have been renamed or replaced
        // since, and a guess would scan an old branch to a clean finish.
        // A failed lookup is worth retrying. An empty answer is either: the
        // repository has none (Bitbucket's empty repository), or a provider
        // that answers empty on errors (Bitbucket Cloud does), so its message
        // names both.
        const defaultBranch = await this.codeManagementService
            .getDefaultBranch(
                {
                    organizationAndTeamData: orgTeam,
                    repository: { id: repository.id, name: repository.name },
                    // A fallback name ("main", "master") would be scanned
                    // as the default; only a confirmed branch is.
                    strict: true,
                },
                platform,
            )
            .catch(() => {
                throw new ServiceUnavailableException(
                    DEFAULT_BRANCH_UNREADABLE_MESSAGE,
                );
            });
        if (!defaultBranch) {
            throw new ServiceUnavailableException(NO_DEFAULT_BRANCH_MESSAGE);
        }

        const scan = await this.scans
            .create({
                organizationId: orgTeam.organizationId,
                teamId: orgTeam.teamId,
                repository: {
                    id: repositoryKey.id,
                    name: repository.name,
                    fullName,
                    platform: repositoryKey.platform,
                    host: repositoryKey.host,
                    defaultBranch,
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
                ...(input.modelId ? { modelId: input.modelId } : {}),
                mode: input.mode ?? 'incremental',
                ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
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

        // Starts of two repositories can pass the count above together: the
        // oldest scans keep their share, a later one gives its place back.
        if (
            !(
                await this.scans.findOldestActiveIds(
                    orgTeam.organizationId,
                    MAX_ACTIVE_SCANS_PER_ORGANIZATION,
                )
            ).includes(scan.uuid)
        ) {
            await this.scans
                .update(scan.uuid, {
                    status: SecurityScanStatus.FAILED,
                    error: TOO_MANY_ACTIVE_SCANS_MESSAGE,
                    finishedAt: new Date().toISOString(),
                })
                .catch(() => undefined);
            throw new HttpException(
                TOO_MANY_ACTIVE_SCANS_MESSAGE,
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

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
     * The identity a scan of this team's repository is stored under (its
     * platform, instance and id), or the reason it cannot be scanned.
     */
    async repositoryKeyOf(
        orgTeam: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<ScanRepositoryKey> {
        const repository = await this.configuredRepository(
            orgTeam,
            repositoryId,
        );
        return (await this.keyOf(orgTeam, repository)).repositoryKey;
    }

    private async configuredRepository(
        orgTeam: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<ConfiguredRepository> {
        const repositories =
            (await this.integrationConfigService.findIntegrationConfigFormatted<
                ConfiguredRepository[]
            >(IntegrationConfigKey.REPOSITORIES, orgTeam)) ?? [];
        const repository = repositories.find(
            (r) => String(r.id) === String(repositoryId),
        );
        if (!repository) {
            throw new NotFoundException(
                'This repository is not connected to the team.',
            );
        }
        return repository;
    }

    private async keyOf(
        orgTeam: OrganizationAndTeamData,
        repository: ConfiguredRepository,
    ) {
        // A failed lookup throws (a 5xx, worth retrying); only a confirmed
        // absence is the caller's to fix.
        const platform = await this.codeManagementService.findTypeIntegration(
            orgTeam,
            {
                id: String(repository.id),
                name: repository.name,
                fullName: repository.full_name,
            },
        );
        // The platform is half the repository's identity (an id is only
        // unique on it): without an active integration there is no knowing
        // which repository this is, nor a way to clone it.
        if (!platform) {
            throw new BadRequestException(NO_CODE_INTEGRATION_MESSAGE);
        }
        const repositoryKey = {
            platform: String(platform),
            host: repositoryHost(repository.http_url),
            id: String(repository.id),
        };
        // Read access uses this same complete identity. Queuing a hostless
        // scan would spend the team's BYOK budget on a record it cannot see.
        if (!repositoryKey.host) {
            throw new BadRequestException(
                'The repository has no readable Git host. Reconnect it before starting a security scan.',
            );
        }
        return { platform, repositoryKey };
    }

    /**
     * Publishing without a live consumer drops the job, and the scan stays
     * queued until it goes stale. Refuse before writing a record.
     */
    private async assertQueueAvailable(): Promise<void> {
        let consumers: number | null;
        try {
            consumers = await this.queueProbe.consumerCount();
        } catch {
            throw new ServiceUnavailableException(
                SCAN_QUEUE_UNAVAILABLE_MESSAGE,
            );
        }
        if (consumers == null || consumers < 1) {
            throw new ServiceUnavailableException(
                SCAN_QUEUE_UNAVAILABLE_MESSAGE,
            );
        }
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
        modelName: string,
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
            last?.status === SecurityScanStatus.CANCELLED ||
            (last?.status === SecurityScanStatus.COMPLETED &&
                (last.progress ?? []).some((p) => p.state === 'failed'));
        if (!last?.units?.length || !unfinished) {
            return null;
        }
        // `provider:model`, as the scan resolved it: a plan made on another
        // model, or on one not recorded, is not carried on.
        if (last.modelName !== modelName) {
            return null;
        }
        // Areas that failed (a provider outage) run again, with the rest.
        const progress = (last.progress ?? []).filter(
            (p) => p.state === 'done',
        );
        if (progress.length >= last.units.length) {
            return null;
        }
        // The commit the plan was made at: the last scan's own, or the one
        // it carried on (a scan that failed before reading HEAD has none of
        // its own). Without one, nothing ties the plan to a commit, and a
        // plan that cannot be checked against HEAD is not carried on.
        const planCommitSha = last.commitSha ?? last.planCommitSha;
        if (!planCommitSha) {
            return null;
        }
        // Only what can be sighted: a finding the dedup drops must be one
        // the job can mark seen, or its issue would be resolved as unseen.
        const reported = (last.reported ?? []).filter((r) => r.fingerprint);
        const unsightable = new Set(
            (last.reported ?? [])
                .filter((r) => !r.fingerprint)
                .map(
                    (r) =>
                        `${r.vulnerabilityClass}\u0000${normalizeScanPath(r.filePath)}`,
                ),
        );
        // What the finished areas read, at this same commit: this scan does
        // not read them again, yet resolves what they no longer hold. An area
        // holding a finding it cannot sight is left out, so that finding is
        // not resolved for being unseen.
        const unitById = new Map(last.units.map((u) => [u.id, u]));
        const inherited = new Map<VulnClass, Set<string>>();
        for (const p of progress) {
            const unit = unitById.get(p.unitId);
            if (!unit) continue;
            for (const vulnClass of unit.classes) {
                const file = normalizeScanPath(unit.file);
                if (unsightable.has(`${vulnClass}\u0000${file}`)) continue;
                inherited.set(
                    vulnClass,
                    (inherited.get(vulnClass) ?? new Set()).add(file),
                );
            }
        }
        // A unit the limit stopped halfway keeps the lenses that ended: this
        // scan runs only the rest of it, never pays for those again.
        // Only lenses read to the end are carried; one cut short runs again.
        const halfway = (last.progress ?? [])
            .filter(
                (p) =>
                    (p.state === 'skipped_budget' || p.state === 'pending') &&
                    !!p.lensesExamined?.length,
            )
            .map((p) => {
                const read = [
                    ...new Set([
                        ...(p.lensesInherited ?? []),
                        ...(p.lensesExamined ?? []),
                    ]),
                ];
                return {
                    unitId: p.unitId,
                    state: 'pending' as const,
                    findings: 0,
                    lensesRun: read,
                    lensesExamined: [],
                    lensesInherited: read,
                };
            });
        return {
            units: last.units,
            // Done, but not read by this scan: what they examined is
            // inherited below, never a miss of this scan's own.
            progress: [
                ...progress.map(
                    ({ examinedByClass: _carried, ...carried }) => carried,
                ),
                ...halfway,
            ],
            planCommitSha,
            reported,
            coverage: {
                examinedFiles: [],
                examinedByClass: [],
                inheritedExaminedByClass: [...inherited].map(
                    ([vulnerabilityClass, files]) => ({
                        vulnerabilityClass,
                        filePaths: [...files],
                    }),
                ),
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
