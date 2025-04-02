import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import {
    PullRequestCodeReviewTime,
    PullRequestWithFiles,
} from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';

type ValidationResult = {
    pullRequestId: number;
    isValid: boolean;
    totalChanges: number;
};

@Injectable()
export class CodeReviewTimeToMergeArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        const {
            artifact: { artifactConfigs },
        } = payload;

        const timeLimitForReview = artifactConfigs?.timeLimitForReview ?? 1;
        const RECOMENDATION_LIMIT = artifactConfigs?.recommendationLimit ?? 0.3;

        let exceedingCodeReviewTimePercentageFormat = null;
        let artifactResult;
        let alertNeeded;

        const { pullRequestsForRTTM } = payload;

        if (!pullRequestsForRTTM || pullRequestsForRTTM?.length === 0) {
            return;
        }

        const reviewTimesResult = this.calculateRTTM(pullRequestsForRTTM);

        const { exceedingCodeReviewTimePercentage } = this.calculateMetrics(
            reviewTimesResult,
            timeLimitForReview,
        );

        alertNeeded = exceedingCodeReviewTimePercentage > RECOMENDATION_LIMIT;

        if (alertNeeded) {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Negative',
            );

            exceedingCodeReviewTimePercentageFormat = `${Math.round(exceedingCodeReviewTimePercentage * 100)}%`;
        } else {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Positive',
            );

            exceedingCodeReviewTimePercentageFormat = `${Math.round((1 - exceedingCodeReviewTimePercentage) * 100)}%`;
        }

        return formatResult({
            artifact: payload.artifact,
            frequenceType: payload.frequenceType,
            artifactResult: artifactResult,
            period: payload.period,
            organizationId: payload.organization.uuid,
            teamId: payload.team.uuid,
            params: [
                exceedingCodeReviewTimePercentageFormat,
                timeLimitForReview,
            ],
        });
    }

    calculateRTTM(
        pullRequestCodeReviewTime: PullRequestCodeReviewTime[],
    ): { id: number; reviewTime: number }[] {
        return pullRequestCodeReviewTime
            .filter((pr) => pr.created_at && pr.closed_at)
            .map((pr) => {
                const createdAt = new Date(pr.created_at).getTime();
                const closedAt = new Date(pr.closed_at).getTime();
                const reviewTime = (closedAt - createdAt) / (1000 * 60 * 60); // Converting from milliseconds to hours
                return { id: pr.id, reviewTime };
            });
    }

    calculateMetrics(
        reviewTimes: { id: number; reviewTime: number }[],
        timeToReview: number,
    ): {
        averageTime: number;
        exceedingCount: number;
        exceedingCodeReviewTimePercentage: number;
    } {
        const totalReviewTime = reviewTimes.reduce(
            (sum, rt) => sum + rt.reviewTime,
            0,
        );

        const averageTime = totalReviewTime / reviewTimes.length;
        const exceedingCount = reviewTimes.filter(
            (rt) => rt.reviewTime > timeToReview,
        ).length;

        const exceedingCodeReviewTimePercentage =
            exceedingCount / reviewTimes.length;

        return {
            averageTime,
            exceedingCount,
            exceedingCodeReviewTimePercentage,
        };
    }
}
