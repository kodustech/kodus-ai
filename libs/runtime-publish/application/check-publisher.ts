import { CheckConclusion, CheckStatus } from '@libs/core/infrastructure/pipeline/interfaces/checks-adapter.interface';
import type { createLogger } from '@libs/core/log/logger';
import { publishKey, type RuntimePublishRequested } from '@libs/runtime/run';

import { renderBareCheckOutput, renderCheckOutput, renderUndeliveredCheckOutput, runtimeLinks, withPreview } from '../domain/render-runtime-comment';
import { CHECK_STATUS_RANK, type PublicationStore, type RuntimePublication } from '../domain/runtime-publication';
import { checkNameOf, publishEnvironmentOf } from '../domain/publish-environment';
import { CHECKS_PLATFORMS, type ChecksPort } from '../domain/runtime-publish.ports';
import { PUBLISH_LOG_CONTEXT } from './comment-publisher';
import { PublicationFailedError, type PublishOptions, type PublishOutcome, type PublishTarget } from './publication-outcome';

/**
 * Deliveries whose check create answers no check run before the check is
 * given up as unavailable (PAT auth, no checks:write). The adapters answer
 * null for a transient error too, so one null is not enough to give up.
 */
export const MAX_CHECK_CREATE_ATTEMPTS = 3;

const WIRE_CONCLUSION: Record<
    NonNullable<NonNullable<RuntimePublishRequested['check']>['conclusion']>,
    CheckConclusion
> = {
    success: CheckConclusion.SUCCESS,
    failure: CheckConclusion.FAILURE,
    neutral: CheckConclusion.NEUTRAL,
    skipped: CheckConclusion.SKIPPED,
    action_required: CheckConclusion.ACTION_REQUIRED,
    cancelled: CheckConclusion.CANCELLED,
    timed_out: CheckConclusion.TIMED_OUT,
};

const WIRE_STATUS: Record<
    NonNullable<RuntimePublishRequested['check']>['status'],
    CheckStatus
> = {
    queued: CheckStatus.QUEUED,
    in_progress: CheckStatus.IN_PROGRESS,
    completed: CheckStatus.COMPLETED,
};

/** The Run's check on the PR's head: opened, moved through its phases and closed with the verdict. */
export class CheckPublisher {
    constructor(
        private readonly publications: PublicationStore,
        private readonly checks: ChecksPort,
        private readonly dashboardUrl: string | undefined,
        private readonly logger: ReturnType<typeof createLogger>,
    ) {}

    async publish(
        msg: RuntimePublishRequested,
        target: PublishTarget,
        publication: RuntimePublication,
        options: PublishOptions = {},
    ): Promise<PublishOutcome> {
        const { scope, organizationAndTeamData, repository, platformType } =
            target;
        const check = msg.check!;
        const status = WIRE_STATUS[check.status];
        const links = withPreview(runtimeLinks(this.dashboardUrl, { runId: msg.runId, repositoryId: scope.repositoryId }), this.dashboardUrl, msg.runId, target.preview);
        // The sweeper's last try for a final check: close it neutral with the
        // short notice, so it never stays open on the PR.
        const fallback = !!options.fallback && check.status === 'completed';
        // Title, summary and (with a report) the conclusion come from the
        // product's verdict table; the Runtime's title and summary are unused.
        const rendered =
            msg.report && !fallback
                ? renderCheckOutput(msg.report, links, target.workspace ? { workspace: target.workspace } : {})
                : undefined;
        const output = fallback
            ? renderUndeliveredCheckOutput(links)
            : rendered
              ? { title: rendered.title, summary: rendered.summary }
              : renderBareCheckOutput(check, links);
        const wireConclusion = fallback
            ? 'neutral'
            : check.status === 'completed'
              ? (rendered?.conclusion ?? check.conclusion)
              : check.conclusion;
        const done = fallback ? { fallback: true } : {};
        const conclusion = wireConclusion
            ? WIRE_CONCLUSION[wireConclusion]
            : undefined;
        const checkRank = CHECK_STATUS_RANK[check.status];

        if (!CHECKS_PLATFORMS.has(platformType)) {
            await this.publications.complete(msg.key, {
                status: 'skipped',
                reason: 'checks_unavailable',
            });
            return { outcome: 'skipped', key: msg.key, reason: 'checks_unavailable' };
        }

        const adapter = this.checks.getAdapter(platformType);
        // One check per environment the PR runs in, named with the environment: a later success elsewhere never hides a failure here.
        const checkName = checkNameOf(publishEnvironmentOf({ repositoryId: scope.repositoryId, workspace: target.workspace }));
        const repo = { owner: repository.owner, name: repository.name };

        // The final verdict moves the check run the awaiting_approval phase
        // opened, recorded under that phase's own key.
        const finalKey = msg.key === publishKey(msg.runId, msg.attempt, 'check');
        let checkRunId =
            publication.checkRunId ??
            (finalKey
                ? await this.publications.findCheckRunId(
                      publishKey(msg.runId, msg.attempt, 'check', 'awaiting_approval'),
                  )
                : null) ??
            (await adapter.findCheckRun({
                organizationAndTeamData,
                repository: repo,
                headSha: scope.headSha,
                name: checkName,
            }));
        let action: 'created' | 'updated' = 'updated';

        if (!checkRunId) {
            // A run is created open and then closed: the create call carries
            // no conclusion.
            checkRunId = await adapter.createCheckRun({
                organizationAndTeamData,
                repository: repo,
                headSha: scope.headSha,
                status:
                    status === CheckStatus.COMPLETED
                        ? CheckStatus.IN_PROGRESS
                        : status,
                name: checkName,
                output,
            });
            action = 'created';
            if (!checkRunId) {
                // Null is both "this org cannot have checks" (PAT, no
                // checks:write) and a transient platform error: retry a few
                // deliveries, then let the comment carry the result.
                const failures = (publication.checkCreateFailures ?? 0) + 1;
                if (failures < MAX_CHECK_CREATE_ATTEMPTS) {
                    throw new PublicationFailedError(
                        msg.key,
                        'the platform did not create the check',
                        { checkCreateFailures: failures },
                    );
                }
                this.logger.warn({
                    message: 'Runtime check skipped: the platform created no check run after every attempt',
                    context: PUBLISH_LOG_CONTEXT,
                    metadata: { key: msg.key, attempts: failures, organizationId: scope.organizationId },
                });
                await this.publications.complete(msg.key, {
                    status: 'skipped',
                    reason: 'checks_unavailable',
                });
                return {
                    outcome: 'skipped',
                    key: msg.key,
                    reason: 'checks_unavailable',
                };
            }
            if (status !== CheckStatus.COMPLETED) {
                await this.publications.complete(msg.key, {
                    status: 'published',
                    checkRank,
                    checkRunId,
                    ...done,
                });
                return { outcome: 'published', key: msg.key, action };
            }
        }

        const updated = await adapter.updateCheckRun({
            organizationAndTeamData,
            repository: repo,
            checkRunId,
            status,
            conclusion,
            output,
        });
        if (!updated) {
            throw new PublicationFailedError(
                msg.key,
                'the platform did not update the check',
                { checkRunId },
            );
        }
        await this.publications.complete(msg.key, {
            status: 'published',
            checkRank,
            checkRunId,
            ...done,
        });
        return { outcome: 'published', key: msg.key, action };
    }
}
