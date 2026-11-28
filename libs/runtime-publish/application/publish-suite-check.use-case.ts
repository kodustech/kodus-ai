import { Inject, Injectable, Optional } from '@nestjs/common';

import { CheckConclusion, CheckStatus, type CheckRunAnnotation } from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import { createLogger } from '@libs/core/log/logger';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { RuntimeSuitePublishRequestedSchema, SUITE_PUBLISH_EVENT, suitePublishKey, type RuntimeSuitePublishRequested } from '@libs/runtime/run';
import { pageAnnotations, type SuiteCheckConclusion } from '@libs/runtime/suite';
import { randomUUID } from 'crypto';

import { suiteCheckOrderOf, type PullRequestCheckRef, RUNTIME_PR_CHECK_SLOT_STORE_TOKEN, type PullRequestCheckSlotStore } from '../domain/pull-request-check-slot';
import { publishEnvironmentOf } from '../domain/publish-environment';
import { renderSuiteCheckOutput, suiteCheckNameOf } from '../domain/render-suite-check';
import { runtimeLinks } from '../domain/render-runtime-comment';
import { RUNTIME_RUN_TARGET_STORE_TOKEN, type RunTargetStore } from '../domain/run-target';
import { CHECK_STATUS_RANK, type PublicationScope, type PublicationStore } from '../domain/runtime-publication';
import {
    CHECKS_PLATFORMS,
    RUNTIME_PUBLICATION_STORE_TOKEN,
    RUNTIME_PUBLISH_CHECKS_TOKEN,
    RUNTIME_PUBLISH_CODE_MANAGEMENT_TOKEN,
    RUNTIME_PUBLISH_DASHBOARD_URL_TOKEN,
    RUNTIME_PUBLISH_REPOSITORY_RESOLVER_TOKEN,
    type ChecksPort,
    type CodeManagementPort,
    type RepositoryResolver,
} from '../domain/runtime-publish.ports';
import { MAX_CHECK_CREATE_ATTEMPTS } from './check-publisher';
import { PublicationBusyError, PublicationFailedError, type PublishOutcome, type PublishTarget, type RefusalReason } from './publication-outcome';

const LOG_CONTEXT = 'PublishSuiteCheck';

const WIRE_CONCLUSION: Record<SuiteCheckConclusion, CheckConclusion> = {
    success: CheckConclusion.SUCCESS,
    failure: CheckConclusion.FAILURE,
    neutral: CheckConclusion.NEUTRAL,
    timed_out: CheckConclusion.TIMED_OUT,
    cancelled: CheckConclusion.CANCELLED,
};

/**
 * The suite's own check on the PR head (docs/runtime/e2e-suites.md section 10.1): `Kody Runtime e2e`, opened when the suite
 * starts, closed with the conclusion the report's state gives, annotated 50 a request. Where to publish comes only from the
 * target the product stored, like the Run's publication; nothing in the message names a PR. Idempotent by key (one publication
 * per phase of a suite run), ordered by the check slot, and a platform that refuses a write fails the delivery so the broker
 * retries it.
 */
@Injectable()
export class PublishSuiteCheckUseCase {
    private readonly logger = createLogger(PublishSuiteCheckUseCase.name);

    constructor(
        @Inject(RUNTIME_RUN_TARGET_STORE_TOKEN) private readonly targets: Pick<RunTargetStore, 'get'>,
        @Inject(RUNTIME_PUBLICATION_STORE_TOKEN) private readonly publications: PublicationStore,
        @Inject(RUNTIME_PUBLISH_REPOSITORY_RESOLVER_TOKEN) private readonly repositories: RepositoryResolver,
        @Inject(RUNTIME_PUBLISH_CODE_MANAGEMENT_TOKEN) private readonly codeManagement: Pick<CodeManagementPort, 'getTypeIntegration'>,
        @Inject(RUNTIME_PUBLISH_CHECKS_TOKEN) private readonly checks: ChecksPort,
        @Optional() @Inject(RUNTIME_PUBLISH_DASHBOARD_URL_TOKEN) private readonly dashboardUrl?: string,
        @Optional() @Inject(RUNTIME_PR_CHECK_SLOT_STORE_TOKEN) private readonly slots?: PullRequestCheckSlotStore,
    ) {}

    async execute(raw: unknown): Promise<PublishOutcome> {
        const msg = this.parse(raw);
        if ('outcome' in msg) return msg;
        const completed = msg.check.status === 'completed';
        if (msg.key !== suitePublishKey(msg.suiteRunId, completed ? 'final' : 'running')) return this.refuse('key_mismatch', msg);
        const resolved = await this.resolveTarget(msg);
        if ('outcome' in resolved) return resolved;
        const claim = await this.publications.claim({
            key: msg.key,
            runId: msg.suiteRunId,
            attempt: msg.attempt,
            kind: 'check',
            ...resolved.scope,
            checkRank: CHECK_STATUS_RANK[msg.check.status],
        });
        if (claim.state === 'duplicate') return { outcome: 'duplicate', key: msg.key };
        if (claim.state === 'busy') throw new PublicationBusyError(msg.key);
        try {
            return await this.publishUnderSlot(msg, resolved, claim.publication);
        } catch (error) {
            await this.publications.release(msg.key, error instanceof Error ? error.message : String(error), error instanceof PublicationFailedError ? error.keep : undefined);
            throw error;
        }
    }

    private parse(raw: unknown): RuntimeSuitePublishRequested | PublishOutcome {
        let payload: unknown = raw;
        if (isRecord(raw) && 'event_name' in raw && 'payload' in raw) {
            if (raw.event_name !== SUITE_PUBLISH_EVENT) return this.refuse('unexpected_event');
            payload = raw.payload;
        }
        if (!isRecord(payload)) return this.refuse('invalid_message');
        const { workflowType, ...rest } = payload;
        if (workflowType !== undefined && workflowType !== WorkflowType.RUNTIME_PUBLISH) return this.refuse('unexpected_event');
        const parsed = RuntimeSuitePublishRequestedSchema.safeParse(rest);
        if (!parsed.success) return this.refuse('invalid_message', undefined, { issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join('.'), code: i.code })) });
        return parsed.data;
    }

    private async resolveTarget(msg: RuntimeSuitePublishRequested): Promise<PublishTarget | PublishOutcome> {
        const stored = await this.targets.get(msg.targetId);
        if (!stored) return this.refuse('target_not_found', msg);
        if (stored.attempt !== msg.attempt) return this.refuse('attempt_mismatch', msg);
        if (!stored.organizationId || !stored.teamId || !stored.repositoryId || !stored.pullRequestNumber || !stored.headSha || !stored.platform) return this.refuse('incomplete_record', msg);
        const scope: PublicationScope = { organizationId: stored.organizationId, teamId: stored.teamId, repositoryId: stored.repositoryId, prNumber: stored.pullRequestNumber, headSha: stored.headSha };
        const organizationAndTeamData = { organizationId: scope.organizationId, teamId: scope.teamId };
        // The stored org and team must still own the stored repository in the product's integration config.
        const repository = await this.repositories.resolve(organizationAndTeamData, scope.repositoryId);
        if (!repository) return this.refuse('repository_not_in_org', msg);
        const names = [stored.repositoryName, stored.repositoryFullName].filter(Boolean);
        if (names.length > 0 && !names.some((n) => n === repository.name || n === repository.fullName)) return this.refuse('repository_mismatch', msg);
        const platformType = await this.codeManagement.getTypeIntegration(organizationAndTeamData);
        if (!platformType) return this.refuse('no_integration', msg);
        if (platformType !== stored.platform) return this.refuse('platform_mismatch', msg);
        return { scope, organizationAndTeamData, repository, platformType, ...(stored.workspace?.length ? { workspace: stored.workspace } : {}) };
    }

    /** The suite check of one head under its own slot: a check of an older suite run never moves one a newer run published. */
    private async publishUnderSlot(msg: RuntimeSuitePublishRequested, target: PublishTarget, publication: { checkRunId?: string | number; checkCreateFailures?: number; checkCreateFailuresRank?: number }): Promise<PublishOutcome> {
        if (!this.slots || !CHECKS_PLATFORMS.has(target.platformType)) return this.write(msg, target, publication);
        const completed = msg.check.status === 'completed';
        if (!completed && (await this.publications.hasPublishedVerdict(suitePublishKey(msg.suiteRunId, 'final')))) {
            await this.publications.complete(msg.key, { status: 'skipped', reason: 'superseded_by_final' });
            return { outcome: 'skipped', key: msg.key, reason: 'superseded_by_final' };
        }
        const ref: PullRequestCheckRef = { organizationId: target.scope.organizationId, repositoryId: target.scope.repositoryId, headSha: target.scope.headSha, checkName: suiteCheckNameOf(publishEnvironmentOf({ repositoryId: target.scope.repositoryId, workspace: target.workspace })) };
        const owner = `${msg.key}#${randomUUID()}`;
        const slot = await this.slots.acquire(ref, owner);
        if (!slot) throw new PublicationBusyError(msg.key);
        try {
            const order = suiteCheckOrderOf(msg.report.requestedAt, completed);
            if (slot.checkOrder !== undefined && (order === undefined || slot.checkOrder > order)) {
                await this.publications.complete(msg.key, { status: 'skipped', reason: 'stale_check' });
                return { outcome: 'skipped', key: msg.key, reason: 'stale_check' };
            }
            const outcome = await this.write(msg, target, publication);
            if (outcome.outcome === 'published' && order !== undefined) await this.slots.recordOrder(ref, owner, order);
            return outcome;
        } finally {
            await this.slots.release(ref, owner).catch((error) => this.logger.warn({ message: 'Suite check slot not released; its lease expires on its own', context: LOG_CONTEXT, error, metadata: { key: msg.key } }));
        }
    }

    private async write(msg: RuntimeSuitePublishRequested, target: PublishTarget, publication: { checkRunId?: string | number; checkCreateFailures?: number; checkCreateFailuresRank?: number }): Promise<PublishOutcome> {
        const { scope, organizationAndTeamData, repository, platformType } = target;
        const completed = msg.check.status === 'completed';
        const status = completed ? CheckStatus.COMPLETED : msg.check.status === 'queued' ? CheckStatus.QUEUED : CheckStatus.IN_PROGRESS;
        const checkRank = CHECK_STATUS_RANK[msg.check.status];
        const links = msg.report.mode === 'run' ? runtimeLinks(this.dashboardUrl, { runId: msg.targetId, repositoryId: scope.repositoryId }) : {};
        const rendered = renderSuiteCheckOutput(msg.report, links);
        const conclusion = completed && rendered.conclusion ? WIRE_CONCLUSION[rendered.conclusion] : undefined;
        const checkName = suiteCheckNameOf(publishEnvironmentOf({ repositoryId: scope.repositoryId, workspace: target.workspace }));
        const repo = { owner: repository.owner, name: repository.name };
        if (!CHECKS_PLATFORMS.has(platformType)) {
            await this.publications.complete(msg.key, { status: 'skipped', reason: 'checks_unavailable' });
            return { outcome: 'skipped', key: msg.key, reason: 'checks_unavailable' };
        }
        const adapter = this.checks.getAdapter(platformType);
        // A connection that cannot create check runs gets the check as a commit status.
        if (adapter.createCommitStatus && adapter.isChecksApiAvailable && !(await adapter.isChecksApiAvailable(organizationAndTeamData))) {
            const result = await adapter.createCommitStatus({ organizationAndTeamData, repository: repo, sha: scope.headSha, context: checkName, status, conclusion, description: rendered.title, targetUrl: links.run });
            if (result === 'permission_missing') {
                await this.publications.complete(msg.key, { status: 'skipped', reason: 'status_permission_missing' });
                return { outcome: 'skipped', key: msg.key, reason: 'status_permission_missing' };
            }
            if (result !== 'posted') throw new PublicationFailedError(msg.key, 'the platform did not create the commit status');
            await this.publications.complete(msg.key, { status: 'published', checkRank, commitStatus: true });
            return { outcome: 'published', key: msg.key, action: 'created' };
        }
        const pages = pageAnnotations(completed ? msg.report.annotations.map(toAnnotation) : []);
        const output = { title: rendered.title, summary: rendered.summary };
        let checkRunId =
            publication.checkRunId ??
            (completed ? await this.publications.findCheckRunId(suitePublishKey(msg.suiteRunId, 'running')) : null) ??
            (await adapter.findCheckRun({ organizationAndTeamData, repository: repo, headSha: scope.headSha, name: checkName }));
        let action: 'created' | 'updated' = 'updated';
        if (!checkRunId) {
            checkRunId = await adapter.createCheckRun({ organizationAndTeamData, repository: repo, headSha: scope.headSha, status: completed ? CheckStatus.IN_PROGRESS : status, name: checkName, output });
            action = 'created';
            if (!checkRunId) {
                const sofar = publication.checkCreateFailuresRank === checkRank ? (publication.checkCreateFailures ?? 0) : 0;
                if (sofar + 1 < MAX_CHECK_CREATE_ATTEMPTS) throw new PublicationFailedError(msg.key, 'the platform did not create the check', { checkCreateFailures: sofar + 1, checkCreateFailuresRank: checkRank });
                this.logger.warn({ message: 'Suite check skipped: the platform created no check run after every attempt', context: LOG_CONTEXT, metadata: { key: msg.key, organizationId: scope.organizationId } });
                await this.publications.complete(msg.key, { status: 'skipped', reason: 'checks_unavailable' });
                return { outcome: 'skipped', key: msg.key, reason: 'checks_unavailable' };
            }
            if (!completed) {
                await this.publications.complete(msg.key, { status: 'published', checkRank, checkRunId });
                return { outcome: 'published', key: msg.key, action };
            }
        }
        // The close carries the status and conclusion once, with the first annotations; the follow-up pages only add annotations.
        for (const [i, page] of pages.entries()) {
            const updated = await adapter.updateCheckRun({
                organizationAndTeamData,
                repository: repo,
                checkRunId,
                ...(i === 0 ? { status, conclusion } : {}),
                output: { ...output, ...(page.length ? { annotations: page } : {}) },
            });
            if (!updated) throw new PublicationFailedError(msg.key, 'the platform did not update the check', { checkRunId });
        }
        await this.publications.complete(msg.key, { status: 'published', checkRank, checkRunId });
        return { outcome: 'published', key: msg.key, action };
    }

    private refuse(reason: RefusalReason, msg?: Pick<RuntimeSuitePublishRequested, 'suiteRunId' | 'key' | 'correlationId'>, extra?: Record<string, unknown>): PublishOutcome {
        this.logger.warn({ message: `Runtime suite publication refused: ${reason}`, context: LOG_CONTEXT, metadata: { reason, suiteRunId: msg?.suiteRunId, key: msg?.key, correlationId: msg?.correlationId, ...extra } });
        return { outcome: 'refused', reason, ...(msg ? { runId: msg.suiteRunId, key: msg.key } : {}) };
    }
}

const toAnnotation = (a: RuntimeSuitePublishRequested['report']['annotations'][number]): CheckRunAnnotation => ({
    path: a.path,
    startLine: a.line,
    endLine: a.line,
    level: a.level,
    ...(a.title ? { title: a.title } : {}),
    message: a.message || a.title || 'failed',
});

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
