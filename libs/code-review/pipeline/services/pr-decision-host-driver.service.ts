import { Inject, Injectable, Logger } from '@nestjs/common';

import type {
    HostCallResult,
    HostContext,
    HostDriver,
    HostRecord,
} from '@libs/code-review/domain/risk/pr-decision-applier';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    type ICommentManagerService,
} from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

/**
 * The host projection adapter: the three ordered provider calls the applier
 * drives.
 *
 * Per `design.md §Decision 4` the sequence is:
 *   1. `dismissOwnPullRequestApprovals` (only when a prior Kody
 *      `REQUEST_CHANGES` is active AND the desired state is APPROVE)
 *   2. `approvePullRequest` (only on APPROVE)
 *   3. `postApprovalReason` (always — the conditional approval comment)
 *
 * Every call must be idempotent, because the applier retries the whole
 * sequence on a `retry` result without rolling back the earlier steps.
 *
 * The driver is STATELESS: the organisation and the repository arrive on
 * every call. The reconciler may run for several PRs concurrently in one
 * worker process, so a module-level holder would let one PR's projection
 * write to another PR's repository.
 *
 * Failure mapping: a thrown error is a `retry` (the provider may be
 * transiently unavailable) except for a permission/auth failure, which is
 * `fatal` — retrying would fail the same way and only waste provider quota.
 */
@Injectable()
export class PrDecisionHostDriverService implements HostDriver {
    private readonly logger = new Logger(PrDecisionHostDriverService.name);

    constructor(
        private readonly codeManagement: CodeManagementService,
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManager: ICommentManagerService,
    ) {}

    async dismissIfNeeded(
        hostRecord: HostRecord,
        host: HostContext,
    ): Promise<HostCallResult> {
        try {
            await this.codeManagement.dismissOwnPullRequestApprovals({
                organizationAndTeamData: host.organizationAndTeamData,
                repository: host.repository,
                prNumber: hostRecord.prNumber,
                reason: 'The findings behind this request are resolved; Kody is approving this pull request.',
            });
            return { status: 'ok' };
        } catch (error) {
            return this.classify('dismissOwnPullRequestApprovals', error);
        }
    }

    async approve(
        hostRecord: HostRecord,
        host: HostContext,
    ): Promise<HostCallResult> {
        try {
            await this.codeManagement.approvePullRequest({
                organizationAndTeamData: host.organizationAndTeamData,
                repository: host.repository,
                prNumber: hostRecord.prNumber,
                headSha: hostRecord.headSha,
            });
            return { status: 'ok' };
        } catch (error) {
            return this.classify('approvePullRequest', error);
        }
    }

    async upsertDecisionComment(
        hostRecord: HostRecord,
        comment: { kind: 'approve' | 'hold'; reason: string },
        host: HostContext,
    ): Promise<HostCallResult> {
        try {
            // `postApprovalReason` upserts: it finds Kody's existing reason
            // comment and updates it, or creates one. That is the idempotency
            // the applier relies on.
            await this.commentManager.postApprovalReason(
                host.organizationAndTeamData,
                hostRecord.prNumber,
                host.repository,
                comment.reason,
                comment.kind,
            );
            return { status: 'ok' };
        } catch (error) {
            return this.classify('postApprovalReason', error);
        }
    }

    /**
     * A provider failure is retryable unless it is a permission problem.
     * A 401/403 will fail identically on every retry, so it is fatal and the
     * reconcile terminates instead of burning the provider's quota.
     */
    private classify(call: string, error: unknown): HostCallResult {
        const message =
            error instanceof Error ? error.message : String(error ?? '');
        const status =
            (error as any)?.status ?? (error as any)?.response?.status;
        const fatal =
            status === 401 ||
            status === 403 ||
            status === 404 ||
            /unauthorized|forbidden|not found/i.test(message);

        this.logger.warn?.({
            message: `[pr-decision] host call ${call} failed (${fatal ? 'fatal' : 'retry'})`,
            context: PrDecisionHostDriverService.name,
            metadata: { status, message: message.slice(0, 300) },
        });

        return fatal
            ? { status: 'fatal', reason: message || `${call} failed` }
            : { status: 'retry', reason: message || `${call} failed` };
    }
}
