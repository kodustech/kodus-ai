import { Inject, Injectable } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { PlatformType } from '@libs/core/domain/enums';
import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    ISandboxLeaseManager,
    SANDBOX_LEASE_MANAGER_TOKEN,
} from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
import { buildGitAuthHeader } from '@libs/sandbox/infrastructure/providers/git-auth-header';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { PricingResolver } from '@libs/analytics/application/use-cases/usage/pricing-resolver';
import { SpendLimitConfigService } from '@libs/analytics/application/spend-limit/spend-limit-config.service';
import {
    IIssuesService,
    ISSUES_SERVICE_TOKEN,
} from '@libs/issues/domain/contracts/issues.service.contract';
import { computeScanFingerprint } from '@libs/issues/domain/scan-fingerprint';
import {
    IKodyIssuesManagementService,
    KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/KodyIssuesManagement.contract';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { raceWithAbortSignal } from '@libs/core/workflow/infrastructure/abort-signal-race';

import { ScanBudgetMeter, validateBudget } from '../domain/budget-meter';
import {
    ScanFinding,
    ScanReportedFinding,
    SecurityScanOutcomeCounts,
    SecurityScanRecord,
    SecurityScanStatus,
} from '../domain/security-scan.types';
import {
    ISecurityScanRepository,
    SECURITY_SCAN_REPOSITORY_TOKEN,
} from '../infrastructure/security-scan.repository';
import { SecurityScanEngine } from './security-scan-engine';
import { ScanOwnerResolver } from './scan-owner-resolver';
import { resolveScanModel } from './scan-model';

const logger = createLogger('SecurityScanJobProcessor');

/**
 * The E2B sandbox lives at most 35 minutes and the job is cut at 34: stop
 * starting units at 20, leaving room for the unit in flight (five lenses and
 * a reproduction test whose install is capped at 5 minutes).
 */
export const SCAN_SLICE_MS = 20 * 60 * 1000;
const LEASE_TTL_MS = 34 * 60 * 1000;
export const SCAN_MAX_UNITS = 400;

export interface SecurityScanJobPayload {
    scanId: string;
    organizationAndTeamData: OrganizationAndTeamData;
}

@Injectable()
export class SecurityScanJobProcessor implements IJobProcessorService {
    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueue: IJobQueueService,
        @Inject(SECURITY_SCAN_REPOSITORY_TOKEN)
        private readonly scans: ISecurityScanRepository,
        @Inject(SANDBOX_LEASE_MANAGER_TOKEN)
        private readonly leaseManager: ISandboxLeaseManager,
        private readonly codeManagementService: CodeManagementService,
        private readonly permissionValidationService: PermissionValidationService,
        private readonly pricingResolver: PricingResolver,
        private readonly spendLimitConfig: SpendLimitConfigService,
        @Inject(ISSUES_SERVICE_TOKEN)
        private readonly issuesService: IIssuesService,
        @Inject(KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN)
        private readonly kodyIssuesManagement: IKodyIssuesManagementService,
    ) {}

    async process(jobId: string, signal?: AbortSignal): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);
        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }
        const payload = job.payload as unknown as SecurityScanJobPayload;
        const scan = payload?.scanId
            ? await this.scans.findById(payload.scanId)
            : null;
        if (!scan) {
            await this.markFailed(jobId, new Error('Security scan not found'));
            return;
        }
        if (
            scan.status !== SecurityScanStatus.QUEUED &&
            scan.status !== SecurityScanStatus.RUNNING
        ) {
            await this.markCompleted(jobId, { skipped: scan.status });
            return;
        }

        await this.jobRepository.update(jobId, {
            status: JobStatus.PROCESSING,
            startedAt: new Date(),
            currentStage: 'SCANNING',
        });
        scan.startedAt ??= new Date().toISOString();
        await this.scans.update(scan.uuid, {
            status: SecurityScanStatus.RUNNING,
            startedAt: scan.startedAt,
        });

        let releaseLease: (() => Promise<void>) | undefined;
        try {
            await raceWithAbortSignal(
                (async () => {
                    const outcome = await this.runSlice(
                        scan,
                        payload.organizationAndTeamData,
                        signal,
                        (release) => (releaseLease = release),
                    );
                    await this.markCompleted(jobId, outcome);
                })(),
                signal,
            );
        } catch (error) {
            logger.error({
                message: `Security scan ${scan.uuid} failed`,
                context: SecurityScanJobProcessor.name,
                error,
                metadata: {
                    scanId: scan.uuid,
                    organizationId: scan.organizationId,
                    repositoryId: scan.repository.id,
                },
            });
            await this.scans.update(scan.uuid, {
                status: SecurityScanStatus.FAILED,
                error: String(error?.message ?? error).slice(0, 500),
                finishedAt: new Date().toISOString(),
            });
            await this.markFailed(jobId, error);
        } finally {
            try {
                await releaseLease?.();
            } catch {
                // The reaper kills a sandbox whose cleanup failed.
            }
        }
    }

    private async runSlice(
        scan: SecurityScanRecord,
        orgTeam: OrganizationAndTeamData,
        signal: AbortSignal | undefined,
        onLease: (release: () => Promise<void>) => void,
    ): Promise<Record<string, unknown>> {
        const sliceStartedAt = Date.now();

        const { model, rates } = await resolveScanModel({
            organizationAndTeamData: orgTeam,
            permissionValidationService: this.permissionValidationService,
            pricingResolver: this.pricingResolver,
            pricingOverrides: (await this.spendLimitConfig.getConfig(orgTeam))
                ?.modelPricing,
        });

        // Priced at start, the model may have lost its price since: a USD cap
        // it cannot compute would never stop the scan.
        const budgetError = validateBudget(scan.budget, !!rates);
        if (budgetError) {
            throw new Error(budgetError);
        }
        const meter = new ScanBudgetMeter(scan.budget, rates, scan.spend);

        const cloneParams = await this.codeManagementService.getCloneParams(
            {
                repository: {
                    id: scan.repository.id,
                    defaultBranch: scan.repository.defaultBranch,
                    fullName: scan.repository.fullName,
                    name:
                        scan.repository.fullName.split('/').pop() ||
                        scan.repository.name,
                },
                organizationAndTeamData: orgTeam,
            },
            scan.repository.platform as PlatformType,
        );
        if (!cloneParams?.url) {
            throw new Error(
                `Could not resolve how to clone ${scan.repository.fullName}`,
            );
        }
        const branch = scan.repository.defaultBranch.replace(
            /^refs\/heads\//,
            '',
        );

        const acquired = await this.leaseManager.acquire(
            // org:repo:<slot> — the lease manager's key shape; one key per
            // slice, so a continuation never joins the previous slice's sandbox.
            `${scan.organizationId}:${scan.repository.id}:security-scan-${scan.uuid}-${sliceStartedAt}`,
            'security-scan',
            LEASE_TTL_MS,
            {
                cloneUrl: cloneParams.url,
                authToken: cloneParams.auth?.token || '',
                authUsername: cloneParams.auth?.username,
                branch,
                platform: scan.repository.platform as PlatformType,
                sandboxMetadata: { stage: 'security-scan' },
            },
            { signal },
        );
        const sandbox = acquired.sandbox;
        onLease(() => sandbox.cleanup());

        const head = await sandbox
            .run(`git -C ${sandbox.repoDir} rev-parse HEAD`, {
                timeoutMs: 10_000,
            })
            .catch(() => undefined);
        const commitSha = head?.stdout?.trim() || scan.commitSha;
        if (commitSha && commitSha !== scan.commitSha) {
            await this.scans.update(scan.uuid, { commitSha });
        }

        const owners = new ScanOwnerResolver(sandbox, {
            cloneUrl: cloneParams.url,
            branch,
            authHeader: cloneParams.auth?.token
                ? buildGitAuthHeader(
                      scan.repository.platform as PlatformType,
                      cloneParams.auth.token,
                      cloneParams.auth.username,
                  )
                : undefined,
        });

        const counts: SecurityScanOutcomeCounts = {
            created: scan.outcome?.created ?? 0,
            stillOpen: scan.outcome?.stillOpen ?? 0,
            reopened: scan.outcome?.reopened ?? 0,
            dismissed: scan.outcome?.dismissed ?? 0,
            resolved: scan.outcome?.resolved ?? 0,
        };

        const engine = new SecurityScanEngine();
        const result = await engine.run({
            organizationId: scan.organizationId,
            teamId: scan.teamId,
            repositoryId: scan.repository.id,
            repositoryFullName: scan.repository.fullName,
            sandbox,
            model,
            meter,
            signal,
            deadlineAt: sliceStartedAt + SCAN_SLICE_MS,
            maxUnits: SCAN_MAX_UNITS,
            units: scan.units,
            progress: scan.progress,
            reported: scan.reported,
            reproduce: true,
            onPlanned: async (units, languages) => {
                await this.scans.update(scan.uuid, {
                    units,
                    modelName: model.modelName,
                    coverage: {
                        examinedFiles: [],
                        unitsTotal: units.length,
                        unitsDone: 0,
                        unitsFailed: 0,
                        unitsSkippedByBudget: 0,
                        languages,
                    },
                });
            },
            onUnitDone: async (progress, findings) => {
                for (const finding of findings) {
                    const outcome = await this.storeFinding(
                        scan,
                        finding,
                        commitSha,
                        owners,
                    );
                    if (outcome) {
                        counts[
                            outcome === 'still_open' ? 'stillOpen' : outcome
                        ]++;
                    }
                }
                if (findings.length) {
                    // The issues list is cached per organization for 15 minutes.
                    await this.kodyIssuesManagement
                        .clearIssuesCache(scan.organizationId)
                        .catch(() => undefined);
                }
                const current = await this.scans.findById(scan.uuid);
                const list = (current?.progress ?? []).filter(
                    (p) => p.unitId !== progress.unitId,
                );
                if (progress.state !== 'pending') {
                    list.push(progress);
                }
                await this.scans.update(
                    scan.uuid,
                    {
                        progress: list,
                        spend: meter.snapshot(),
                        outcome: counts,
                        // Live counts for the scans list; the examined files are
                        // only settled when the slice ends.
                        ...(current?.coverage && {
                            coverage: {
                                ...current.coverage,
                                unitsDone: list.filter(
                                    (p) => p.state === 'done',
                                ).length,
                                unitsFailed: list.filter(
                                    (p) => p.state === 'failed',
                                ).length,
                                unitsSkippedByBudget: list.filter(
                                    (p) => p.state === 'skipped_budget',
                                ).length,
                            },
                        }),
                    },
                    findings.map(toReported),
                );
            },
        });

        const examined = new Set([
            ...(scan.coverage?.examinedFiles ?? []),
            ...result.examinedFiles,
        ]);
        const coverage = {
            examinedFiles: [...examined],
            unitsTotal: result.units.length,
            unitsDone: result.progress.filter((p) => p.state === 'done').length,
            unitsFailed: result.progress.filter((p) => p.state === 'failed')
                .length,
            unitsSkippedByBudget: result.progress.filter(
                (p) => p.state === 'skipped_budget',
            ).length,
            languages: result.languages,
        };

        if (!result.finished && !result.stoppedByBudget && !signal?.aborted) {
            // The sandbox is about to expire: persist and let a new job, with
            // a new sandbox, take the rest.
            await this.scans.update(scan.uuid, {
                progress: result.progress,
                spend: meter.snapshot(),
                coverage,
                outcome: counts,
            });
            await this.enqueueContinuation(scan, orgTeam);
            return { continued: true, units: coverage };
        }

        if (signal?.aborted && !result.stoppedByBudget) {
            throw new Error('Security scan job was aborted');
        }

        // Only now is it known which files this scan examined end to end; an
        // open finding there that no unit reported again is gone.
        counts.resolved += await this.issuesService.resolveUnseenScanFindings({
            organizationId: scan.organizationId,
            repositoryId: scan.repository.id,
            scanId: scan.uuid,
            filePaths: coverage.examinedFiles,
            scanStartedAt: scan.startedAt ?? new Date().toISOString(),
        });

        await this.kodyIssuesManagement
            .clearIssuesCache(scan.organizationId)
            .catch(() => undefined);

        await this.scans.update(scan.uuid, {
            status: result.stoppedByBudget
                ? SecurityScanStatus.STOPPED_BY_BUDGET
                : SecurityScanStatus.COMPLETED,
            progress: result.progress,
            spend: meter.snapshot(),
            coverage,
            outcome: counts,
            finishedAt: new Date().toISOString(),
        });

        return { status: 'finished', outcome: counts, spend: meter.snapshot() };
    }

    private async storeFinding(
        scan: SecurityScanRecord,
        finding: ScanFinding,
        commitSha: string | undefined,
        owners: ScanOwnerResolver,
    ) {
        try {
            const owner = await owners.ownerOf(finding.filePath);
            const { outcome } = await this.issuesService.upsertScanFinding({
                title: finding.title,
                description: buildIssueDescription(finding, commitSha),
                filePath: finding.filePath,
                language: finding.language,
                label: LabelType.SECURITY,
                severity: finding.severity as SeverityLevel,
                repository: {
                    id: scan.repository.id,
                    name: scan.repository.name,
                    full_name: scan.repository.fullName,
                    platform: scan.repository.platform as PlatformType,
                },
                organizationId: scan.organizationId,
                owner,
                reporter: { gitId: 'kodus', username: 'Kodus' },
                fingerprint: computeScanFingerprint({
                    repositoryId: scan.repository.id,
                    vulnerabilityClass: finding.vulnerabilityClass,
                    filePath: finding.filePath,
                    symbol: finding.symbol,
                    cwe: finding.cwe,
                }),
                cwe: finding.cwe,
                vulnerabilityClass: finding.vulnerabilityClass,
                symbol: finding.symbol,
                startLine: finding.startLine,
                endLine: finding.endLine,
                evidence: {
                    attackPath: finding.attackPath,
                    ...(finding.reproduction
                        ? { reproduction: finding.reproduction }
                        : {}),
                },
                lastSeenScanId: scan.uuid,
            });
            return outcome;
        } catch (error) {
            logger.error({
                message: 'Could not store a security-scan finding',
                context: SecurityScanJobProcessor.name,
                error,
                metadata: {
                    scanId: scan.uuid,
                    filePath: finding.filePath,
                },
            });
            return undefined;
        }
    }

    private async enqueueContinuation(
        scan: SecurityScanRecord,
        orgTeam: OrganizationAndTeamData,
    ): Promise<void> {
        await this.jobQueue.enqueue({
            correlationId: scan.uuid,
            workflowType: WorkflowType.SECURITY_SCAN,
            handlerType: HandlerType.SIMPLE_FUNCTION,
            payload: { scanId: scan.uuid, organizationAndTeamData: orgTeam },
            organizationAndTeamData: orgTeam,
            status: JobStatus.PENDING,
            priority: 0,
            retryCount: 0,
            maxRetries: 2,
        });
    }

    async handleFailure(jobId: string, error: Error): Promise<void> {
        await this.markFailed(jobId, error);
    }

    private async markFailed(jobId: string, error: Error): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.FAILED,
            errorClassification: ErrorClassification.PERMANENT,
            lastError: String(error?.message ?? error).slice(0, 1000),
            failedAt: new Date(),
        } as any);
    }

    async markCompleted(jobId: string, result?: unknown): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.COMPLETED,
            completedAt: new Date(),
            currentStage: 'DONE',
            result,
        } as any);
    }
}

/**
 * The issue body: what the auditor wrote and how to fix it. The attack path
 * and the reproduction test travel as structured evidence on the issue, which
 * the issue page shows in sections of their own.
 */
export function buildIssueDescription(
    finding: ScanFinding,
    commitSha?: string,
): string {
    const parts = [finding.description];
    if (finding.suggestedFix) {
        parts.push(`**Fix**\n${finding.suggestedFix}`);
    }
    if (finding.cwe || commitSha) {
        parts.push(
            [finding.cwe, commitSha ? `found at ${commitSha.slice(0, 12)}` : '']
                .filter(Boolean)
                .join(' · '),
        );
    }
    return parts.join('\n\n');
}

function toReported(finding: ScanFinding): ScanReportedFinding {
    return {
        vulnerabilityClass: finding.vulnerabilityClass,
        cwe: finding.cwe,
        title: finding.title,
        description: finding.description,
        severity: finding.severity,
        filePath: finding.filePath,
        startLine: finding.startLine,
        endLine: finding.endLine,
        attackPath: finding.attackPath,
    };
}
