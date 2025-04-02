import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import { PullRequestWithFiles } from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';

type ValidationResult = {
    pullRequestId: number;
    isValid: boolean;
    totalChanges: number;
};

@Injectable()
export class PullRequestWithSizeGreaterThanLimitArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        const {
            artifact: { artifactConfigs },
        } = payload;

        const maxChanges = artifactConfigs?.pullRequestSizeLimit ?? 400;
        const RECOMENDATION_LIMIT = artifactConfigs?.recommendationLimit ?? 0.3;

        let artifactResult;
        let alertNeeded;

        const { pullRequestsWithFiles } = payload;

        if (!pullRequestsWithFiles || pullRequestsWithFiles?.length === 0) {
            return;
        }

        const validationResult = this.validatePullRequestSize(
            payload?.pullRequestsWithFiles,
            maxChanges,
        );

        const invalidPRs = validationResult.filter((result) => !result.isValid);
        const invalidPercentage = invalidPRs.length / validationResult.length;

        alertNeeded = invalidPercentage > RECOMENDATION_LIMIT;

        if (alertNeeded) {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Negative',
            );
        } else {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Positive',
            );
        }

        const pullRequestGreaterThanLimit = `${Math.round(invalidPercentage * 100)}%`;

        return formatResult({
            artifact: payload.artifact,
            frequenceType: payload.frequenceType,
            artifactResult: artifactResult,
            period: payload.period,
            organizationId: payload.organization.uuid,
            teamId: payload.team.uuid,
            params: [pullRequestGreaterThanLimit, maxChanges],
        });
    }

    validatePullRequestSize(
        pullRequests: PullRequestWithFiles[],
        maxChanges: number,
    ): ValidationResult[] {
        return pullRequests.map((pr) => {
            const totalChanges =
                pr.pullRequestFiles?.reduce(
                    (sum, file) => sum + file.changes,
                    0,
                ) || 0;

            const isValid = totalChanges <= maxChanges;

            return {
                pullRequestId: pr.id,
                isValid,
                totalChanges,
            };
        });
    }
}
