import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';

@Injectable()
export class WorkItemWithClearDescriptionArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        const RECOMENDATION_LIMIT = 0.6; // if the activity score is less than 60%, notify

        const workItemsWithGoodDescription =
            payload.workItemsDescriptionQuality.dataAnalyzed
                .workItemsWithGoodDescription;

        const workItemsWithBadDescription =
            payload.workItemsDescriptionQuality.dataAnalyzed
                .workItemsWithBadDescription;

        const totalWorkItemsAnalyzed =
            workItemsWithGoodDescription.length +
            workItemsWithBadDescription.length;

        const percentageOfGoodDescription =
            workItemsWithGoodDescription.length / totalWorkItemsAnalyzed;

        const percentageOfBadDescription =
            workItemsWithBadDescription.length / totalWorkItemsAnalyzed;

        let artifactResult;
        let percentageFormatedToSend;
        let numberOfWorkItemsToSend;
        let additionalData;

        if (percentageOfGoodDescription < RECOMENDATION_LIMIT) {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Negative',
            );

            numberOfWorkItemsToSend = workItemsWithBadDescription.length;
            percentageFormatedToSend = `${Math.round(
                percentageOfBadDescription * 100,
            )}%`;
            additionalData = workItemsWithBadDescription;
        } else {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Positive',
            );

            numberOfWorkItemsToSend = workItemsWithGoodDescription.length;
            percentageFormatedToSend = `${Math.round(
                percentageOfGoodDescription * 100,
            )}%`;
            additionalData = workItemsWithGoodDescription;
        }

        return formatResult({
            artifact: payload.artifact,
            frequenceType: payload.frequenceType,
            artifactResult: artifactResult,
            period: payload.period,
            organizationId: payload.organization.uuid,
            teamId: payload.team.uuid,
            params: [numberOfWorkItemsToSend, percentageFormatedToSend],
            additionalData,
        });
    }
}
