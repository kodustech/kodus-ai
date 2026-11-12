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
import {
    computeScanFingerprint,
    normalizeScanPath,
} from '@libs/issues/domain/scan-fingerprint';
import {
    IKodyIssuesManagementService,
    KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/KodyIssuesManagement.contract';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { raceWithAbortSignal } from '@libs/core/workflow/infrastructure/abort-signal-race';
import { extractProviderMessage } from '@libs/llm/review-error-diagnostics';

import { ScanBudgetMeter, validateBudget } from '../domain/budget-meter';
import {
    ScanExaminedClass,
    ScanFinding,
    ScanReportedFinding,
    ScanUnitProgress,
    SecurityScanOutcomeCounts,
    SecurityScanRecord,
    SecurityScanStatus,
} from '../domain/security-scan.types';
import type { VulnClass } from '../domain/surface/surface.types';
import {
    ISecurityScanRepository,
    SECURITY_SCAN_REPOSITORY_TOKEN,
} from '../infrastructure/security-scan.repository';
import { SecurityScanEngine } from './security-scan-engine';
import { ScanOwnerResolver } from './scan-owner-resolver';
import { resolveScanModel, SCAN_NEEDS_BYOK_MESSAGE } from './scan-model';
import {
    SCAN_HEAD_UNREADABLE_MESSAGE,
    SCAN_NO_AREA_EXAMINED_MESSAGE,
    SCAN_NO_PROGRESS_MESSAGE,
    ScanFailure,
} from '../domain/scan-failure';

const logger = createLogger('SecurityScanJobProcessor');

/**
 * The E2B sandbox lives at most 35 minutes and the job is cut at 34: stop
 * starting units at 20, leaving room for the unit in flight (five lenses and
 * a reproduction test whose install is capped at 5 minutes).
 */
export const SCAN_SLICE_MS = 20 * 60 * 1000;
const LEASE_TTL_MS = 34 * 60 * 1000;
/**
 * The most areas one plan holds. It bounds the stored plan, not the scan's
 * length: a plan runs across as many slices as it needs.
 */
export const SCAN_MAX_UNITS = 2000;

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

        const active = [SecurityScanStatus.QUEUED, SecurityScanStatus.RUNNING];
        let releaseLease: (() => Promise<void>) | undefined;
        let outcome: Record<string, unknown>;
        try {
            // Inside the try: a failure here fails the scan, instead of
            // leaving it queued (and its repository locked) until it goes
            // stale.
            await this.jobRepository.update(jobId, {
                status: JobStatus.PROCESSING,
                startedAt: new Date(),
                currentStage: 'SCANNING',
            });
            scan.startedAt ??= new Date().toISOString();
            // Only while it is still active: failed as stale (its key freed)
            // since it was read, it must not run beside a new scan.
            const running = await this.scans.update(
                scan.uuid,
                {
                    status: SecurityScanStatus.RUNNING,
                    startedAt: scan.startedAt,
                },
                undefined,
                active,
            );
            if (!running) {
                await this.markCompleted(jobId, { skipped: 'not active' });
                return;
            }
            outcome = await raceWithAbortSignal(
                this.runSlice(
                    scan,
                    payload.organizationAndTeamData,
                    signal,
                    (release) => (releaseLease = release),
                ),
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
            // A scan another process ended (completed, or failed as stale)
            // keeps the state it has.
            await this.scans.update(
                scan.uuid,
                {
                    status: SecurityScanStatus.FAILED,
                    error: scanErrorMessage(error),
                    finishedAt: new Date().toISOString(),
                },
                undefined,
                active,
            );
            await this.markFailed(jobId, error);
            return;
        } finally {
            try {
                await releaseLease?.();
            } catch {
                // The reaper kills a sandbox whose cleanup failed.
            }
        }
        // The slice is done (completed, or its continuation queued): a failure
        // to record the job must not fail the scan.
        await this.markCompleted(jobId, outcome).catch((error) =>
            logger.warn({
                message: `Security scan job ${jobId} ran but could not be marked completed`,
                context: SecurityScanJobProcessor.name,
                error,
                metadata: {
                    scanId: scan.uuid,
                    organizationId: scan.organizationId,
                    teamId: scan.teamId,
                    repositoryId: scan.repository.id,
                },
            }),
        );
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

        // The organization's model may have been disconnected since the start.
        if (!model.slot) {
            throw new ScanFailure(SCAN_NEEDS_BYOK_MESSAGE);
        }
        // Priced at start, the model may have lost its price since: a USD cap
        // it cannot compute would never stop the scan.
        const budgetError = validateBudget(scan.budget, !!rates);
        if (budgetError) {
            throw new ScanFailure(budgetError);
        }
        const meter = new ScanBudgetMeter(
            scan.budget,
            rates,
            scan.spend,
            model.contextWindowTokens,
        );

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
            throw new ScanFailure(
                `Could not resolve how to clone ${scan.repository.fullName}. Check the repository's integration.`,
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
                // A continuation reads the commit the first slice read: its
                // plan, done units and findings belong to that commit.
                ...(scan.commitSha ? { checkoutSha: scan.commitSha } : {}),
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
        const headSha = head?.stdout?.trim();
        const commitSha = headSha || scan.commitSha;
        // The scan's first job: the one that sets its commit.
        const firstJob = !scan.commitSha;
        // Without the commit, nothing ties the scan to one: its continuations
        // would clone a moving branch, and its plan could not be checked.
        if (firstJob && !headSha) {
            throw new ScanFailure(SCAN_HEAD_UNREADABLE_MESSAGE);
        }
        // A plan carried from an earlier scan holds for the commit it was made
        // at: past it, its done areas say nothing about this code and new
        // files are missing from it, so the repository is mapped again.
        // Only a HEAD actually read can say the branch moved: an unread one
        // keeps the plan.
        const stalePlan =
            firstJob &&
            !!scan.planCommitSha &&
            !!headSha &&
            headSha !== scan.planCommitSha;
        if (stalePlan) {
            // What the plan's areas found and read is of that commit too:
            // neither compared against, sighted nor resolved on this one.
            scan.units = [];
            scan.progress = [];
            scan.reported = [];
            if (scan.coverage) {
                scan.coverage = {
                    ...scan.coverage,
                    inheritedExaminedByClass: [],
                };
            }
        }
        if ((commitSha && commitSha !== scan.commitSha) || stalePlan) {
            await this.scans.update(scan.uuid, {
                ...(commitSha ? { commitSha } : {}),
                ...(stalePlan
                    ? {
                          units: [],
                          progress: [],
                          reported: [],
                          ...(scan.coverage && { coverage: scan.coverage }),
                      }
                    : {}),
            });
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
        // Before the engine runs any repository code in this sandbox.
        await owners.prepareHistory();

        const counts: SecurityScanOutcomeCounts = {
            created: scan.outcome?.created ?? 0,
            stillOpen: scan.outcome?.stillOpen ?? 0,
            reopened: scan.outcome?.reopened ?? 0,
            dismissed: scan.outcome?.dismissed ?? 0,
            resolved: scan.outcome?.resolved ?? 0,
        };

        // Only this job writes the scan's progress while it runs, so it is
        // tracked here instead of re-read from the document after every area.
        const unitStates = new Map(scan.progress.map((p) => [p.unitId, p]));
        const stateCounts = new Map<ScanUnitProgress['state'], number>();
        const tally = (state: ScanUnitProgress['state'], by: number) =>
            stateCounts.set(state, (stateCounts.get(state) ?? 0) + by);
        unitStates.forEach((p) => tally(p.state, 1));
        const countIn = (state: ScanUnitProgress['state']) =>
            stateCounts.get(state) ?? 0;
        let liveCoverage = scan.coverage;

        // Whether this slice made (or grew) the plan: progress of its own.
        let planned = false;
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
            // Read whenever a plan is made or first carried on: the scan's
            // first job, or any job with no plan stored yet. A continuation
            // holds them in its plan already.
            revisit:
                !firstJob && scan.units?.length
                    ? []
                    : await this.issuesService.findOpenScanFindingAreas({
                          organizationId: scan.organizationId,
                          repositoryPlatform: scan.repository
                              .platform as PlatformType,
                          repositoryId: scan.repository.id,
                      }),
            reproduce: true,
            onPlanned: async (units, languages) => {
                planned = true;
                // A carried-on plan keeps the areas it already finished, and
                // what they read.
                liveCoverage = {
                    inheritedExaminedByClass:
                        scan.coverage?.inheritedExaminedByClass ?? [],
                    examinedFiles: [],
                    unitsTotal: units.length,
                    unitsDone: countIn('done'),
                    unitsFailed: countIn('failed'),
                    unitsSkippedByBudget: countIn('skipped_budget'),
                    languages,
                };
                await this.scans.update(scan.uuid, {
                    units,
                    modelName: model.modelName,
                    coverage: liveCoverage,
                });
            },
            onUnitDone: async (progress, findings, sighted) => {
                // An earlier finding a unit found again is seen by this scan.
                if (sighted?.length) {
                    // Found again: one resolved since is reopened.
                    const { sighted: stillOpen, reopened } =
                        await this.issuesService.markScanFindingsSeen({
                            organizationId: scan.organizationId,
                            repositoryPlatform: scan.repository
                                .platform as PlatformType,
                            repositoryId: scan.repository.id,
                            fingerprints: sighted,
                            scanId: scan.uuid,
                            foundAgain: true,
                        });
                    counts.reopened += reopened;
                    counts.stillOpen += stillOpen;
                }
                for (const finding of findings) {
                    const outcome = await this.storeFinding(
                        scan,
                        finding,
                        commitSha,
                        owners,
                    );
                    // A merged occurrence adds to an issue this scan counted.
                    if (outcome !== 'merged') {
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
                const earlier = unitStates.get(progress.unitId);
                if (earlier) {
                    tally(earlier.state, -1);
                    unitStates.delete(progress.unitId);
                }
                if (progress.state !== 'pending') {
                    unitStates.set(progress.unitId, progress);
                    tally(progress.state, 1);
                }
                // Live counts for the scans list; the examined files are only
                // settled when the slice ends.
                if (liveCoverage) {
                    liveCoverage = {
                        ...liveCoverage,
                        unitsDone: countIn('done'),
                        unitsFailed: countIn('failed'),
                        unitsSkippedByBudget: countIn('skipped_budget'),
                    };
                }
                await this.scans.recordUnit(
                    scan.uuid,
                    progress,
                    {
                        spend: meter.snapshot(),
                        outcome: counts,
                        ...(liveCoverage && { coverage: liveCoverage }),
                    },
                    findings.map((f) => toReported(f, fingerprintOf(scan, f))),
                );
            },
        });

        const examined = new Set([
            ...(scan.coverage?.examinedFiles ?? []),
            ...result.examinedFiles,
        ]);
        const coverage = {
            examinedFiles: [...examined],
            examinedByClass: mergeExamined(
                scan.coverage?.examinedByClass ?? [],
                result.examinedByClass,
            ),
            inheritedExaminedByClass:
                scan.coverage?.inheritedExaminedByClass ?? [],
            unitsTotal: result.units.length,
            unitsDone: result.progress.filter((p) => p.state === 'done').length,
            unitsFailed: result.progress.filter((p) => p.state === 'failed')
                .length,
            unitsSkippedByBudget: result.progress.filter(
                (p) => p.state === 'skipped_budget',
            ).length,
            languages: result.languages,
            // Known to the run that made the plan; its continuations keep it.
            mapFailedLanguages:
                result.mapFailedLanguages ??
                scan.coverage?.mapFailedLanguages ??
                [],
            filesBeyondPlan:
                result.filesBeyondPlan ?? scan.coverage?.filesBeyondPlan ?? 0,
        };

        if (!result.finished && !result.stoppedByBudget && !signal?.aborted) {
            // A slice that neither made the plan nor moved a unit would hand
            // the same work to the next one, and the next, forever.
            if (!planned && !movedAUnit(scan.progress ?? [], result.progress)) {
                throw new ScanFailure(SCAN_NO_PROGRESS_MESSAGE);
            }
            // The sandbox is about to expire: persist and let a new job, with
            // a new sandbox, take the rest. Queued again until a worker takes
            // it, so the wait is not read as a stopped worker.
            await this.scans.update(scan.uuid, {
                status: SecurityScanStatus.QUEUED,
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

        // Not one area examined, and some failed (the provider down for every
        // lens): that is a failed scan, never a clean one.
        if (!coverage.unitsDone && coverage.unitsFailed) {
            throw new ScanFailure(SCAN_NO_AREA_EXAMINED_MESSAGE);
        }

        // What this scan carries from an earlier one's plan, in an area it
        // did not read again, it holds as found: seen by it, not resolved
        // below. Where it did read the area again, the unit decided: found
        // again (sighted above) or gone.
        const readAgain = new Set(
            coverage.examinedByClass.flatMap((e) =>
                e.filePaths.map(
                    (f) =>
                        `${e.vulnerabilityClass}\u0000${normalizeScanPath(f)}`,
                ),
            ),
        );
        const held = await this.issuesService.markScanFindingsSeen({
            organizationId: scan.organizationId,
            repositoryPlatform: scan.repository.platform as PlatformType,
            repositoryId: scan.repository.id,
            fingerprints: (scan.reported ?? [])
                .filter(
                    (r) =>
                        !readAgain.has(
                            `${r.vulnerabilityClass}\u0000${normalizeScanPath(r.filePath)}`,
                        ),
                )
                .map((r) => r.fingerprint)
                .filter((fp): fp is string => !!fp),
            scanId: scan.uuid,
        });
        counts.stillOpen += held.sighted;

        // Only now is it known which files this scan examined end to end; an
        // open finding there that no unit reported again is gone.
        counts.resolved += await this.issuesService.resolveUnseenScanFindings({
            organizationId: scan.organizationId,
            repositoryPlatform: scan.repository.platform as PlatformType,
            repositoryId: scan.repository.id,
            scanId: scan.uuid,
            // What this scan read, and what a carried-on plan's finished
            // areas read at this commit.
            examined: mergeExamined(
                coverage.examinedByClass,
                coverage.inheritedExaminedByClass,
            ),
            trackedFiles: result.trackedFiles,
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
                fingerprint: fingerprintOf(scan, finding),
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
                ...(commitSha ? { lastSeenCommitSha: commitSha } : {}),
            });
            return outcome;
        } catch (error) {
            // Not swallowed: the unit is not recorded as done, the scan fails
            // before resolving anything, and running it again retries it.
            logger.error({
                message: 'Could not store a security-scan finding',
                context: SecurityScanJobProcessor.name,
                error,
                metadata: {
                    scanId: scan.uuid,
                    filePath: finding.filePath,
                },
            });
            throw error;
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

/**
 * Whether a unit's state, or the lenses it ran, changed in this slice. A
 * unit the slice never reached comes back pending with no lens run, whether
 * or not it had an entry: that is no move.
 */
function movedAUnit(
    before: ScanUnitProgress[],
    after: ScanUnitProgress[],
): boolean {
    const keyOf = (p: ScanUnitProgress) =>
        `${p.state}:${(p.lensesRun ?? []).join(',')}`;
    const untouched = 'pending:';
    const was = new Map(before.map((p) => [p.unitId, keyOf(p)]));
    return after.some((p) => keyOf(p) !== (was.get(p.unitId) ?? untouched));
}

function fingerprintOf(scan: SecurityScanRecord, finding: ScanFinding): string {
    return computeScanFingerprint({
        repositoryPlatform: scan.repository.platform,
        repositoryId: scan.repository.id,
        vulnerabilityClass: finding.vulnerabilityClass,
        filePath: finding.filePath,
        symbol: finding.symbol,
        cwe: finding.cwe,
        appWide: finding.appWide,
    });
}

function toReported(
    finding: ScanFinding,
    fingerprint: string,
): ScanReportedFinding {
    return {
        fingerprint,
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

export { ScanFailure };

/**
 * What a failed scan shows. Its error is returned by the API to everyone who
 * can see the repository, so the raw message (clone URLs, database errors,
 * internal paths) stays in the log; only a sentence written for the user, or
 * the model provider's own answer, redacted, is kept on the scan.
 */
export function scanErrorMessage(error: unknown): string {
    if (error instanceof ScanFailure) {
        return error.message;
    }
    const provider = extractProviderMessage(error);
    if (provider) {
        return `The model provider refused a request: ${provider}`;
    }
    return 'The scan stopped on an internal error. Its findings so far are kept; run it again, and contact support if it keeps failing.';
}

/** What earlier slices examined, with what this one did. */
function mergeExamined(
    earlier: ScanExaminedClass[],
    now: ScanExaminedClass[],
): ScanExaminedClass[] {
    const byClass = new Map<VulnClass, Set<string>>();
    for (const { vulnerabilityClass, filePaths } of [...earlier, ...now]) {
        const files = byClass.get(vulnerabilityClass) ?? new Set<string>();
        filePaths.forEach((f) => files.add(f));
        byClass.set(vulnerabilityClass, files);
    }
    return [...byClass].map(([vulnerabilityClass, files]) => ({
        vulnerabilityClass,
        filePaths: [...files],
    }));
}
