import { Inject, Injectable } from '@nestjs/common';

import { hasOpenFinding } from '@libs/code-review/domain/approval/own-change-request';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import { PullRequestReviewState } from '@libs/platform/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import type { IPullRequestWithKodyChangeRequest } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

/** Shown on the host next to the withdrawn review, where the host shows one. */
export const OWN_CHANGE_REQUEST_WITHDRAWN_REASON =
    'The critical findings behind this request are resolved.';

/**
 * Kody's "changes requested", from the moment it is made to the moment it
 * leaves. It leaves once the critical findings behind it are resolved;
 * whether Kody then approves is a separate decision, and a PR it will not
 * approve must still stop blocking the merge.
 */
@Injectable()
export class OwnChangeRequestService {
    private readonly logger = createLogger(OwnChangeRequestService.name);

    constructor(
        private readonly codeManagement: CodeManagementService,
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequests: IPullRequestsService,
    ) {}

    /** Remembers a request just made, and the review comments behind it. */
    async record(input: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string };
        prNumber: number;
        commentIds: string[];
        /** A summary the host keeps open next to the request, if it left one. */
        summaryCommentId?: string;
    }): Promise<void> {
        // A request with no comment on record could never be shown resolved.
        if (!input.commentIds.length) return;
        await this.pullRequests.recordKodyChangeRequest(
            input.organizationAndTeamData.organizationId,
            input.repository.id,
            input.prNumber,
            {
                requestedAt: new Date().toISOString(),
                commentIds: input.commentIds,
                summaryCommentId: input.summaryCommentId,
            },
        );
    }

    /** Answers whether the request was withdrawn. */
    async withdrawIfResolved(input: {
        organizationAndTeamData: OrganizationAndTeamData;
        pullRequest: IPullRequestWithKodyChangeRequest;
        isReviewRunning: () => Promise<boolean>;
    }): Promise<boolean> {
        const { organizationAndTeamData, pullRequest } = input;
        const { repository, number: prNumber } = pullRequest;
        const changeRequest = pullRequest.kodyChangeRequest;
        const platformType = pullRequest.provider as PlatformType;
        const request = { organizationAndTeamData, repository, prNumber };
        const forget = () =>
            this.pullRequests.clearKodyChangeRequest(
                organizationAndTeamData.organizationId,
                repository.id,
                prNumber,
                changeRequest.requestedAt,
            );

        // GitLab keeps no review state for it: there the request is the
        // summary discussion alone.
        const hasReviewState = platformType !== PlatformType.GITLAB;
        if (hasReviewState) {
            const status =
                await this.codeManagement.getReviewStatusByPullRequest(request);
            if (status === null) return false;
            if (status !== PullRequestReviewState.CHANGES_REQUESTED) {
                // Kody approved since, or somebody dismissed the review.
                await forget();
                return false;
            }
        }

        const comments =
            platformType === PlatformType.GITHUB
                ? await this.codeManagement.getPullRequestReviewThreads(
                      request,
                      platformType,
                  )
                : await this.codeManagement.getPullRequestReviewComments(
                      request,
                      platformType,
                  );
        if (
            !Array.isArray(comments) ||
            hasOpenFinding(changeRequest.commentIds ?? [], comments, platformType)
        ) {
            return false;
        }

        // Both guard the same thing: a review that requested changes again,
        // over a finding this reading of the request does not hold.
        if (
            (await input.isReviewRunning()) ||
            !(await this.isStillTheRequest(organizationAndTeamData, pullRequest))
        ) {
            return false;
        }

        if (hasReviewState) {
            await this.codeManagement.dismissOwnPullRequestChangeRequests(
                { ...request, reason: OWN_CHANGE_REQUEST_WITHDRAWN_REASON },
                platformType,
            );
        }
        for (const commentId of changeRequest.summaryCommentIds ?? []) {
            await this.codeManagement.markReviewCommentAsResolved(
                { ...request, commentId },
                platformType,
            );
        }
        await forget();

        this.logger.log({
            message: `Withdrew Kody's change request on PR#${prNumber}: its critical findings are resolved`,
            context: OwnChangeRequestService.name,
            metadata: {
                organizationAndTeamData,
                repositoryId: repository.id,
                prNumber,
                platformType,
            },
        });
        return true;
    }

    private async isStillTheRequest(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: IPullRequestWithKodyChangeRequest,
    ): Promise<boolean> {
        const current =
            await this.pullRequests.findOpenPullRequestsWithKodyChangeRequest(
                organizationAndTeamData.organizationId,
            );
        return current.some(
            (candidate) =>
                candidate.number === pullRequest.number &&
                candidate.repository?.id === pullRequest.repository?.id &&
                candidate.kodyChangeRequest?.requestedAt ===
                    pullRequest.kodyChangeRequest.requestedAt,
        );
    }
}
