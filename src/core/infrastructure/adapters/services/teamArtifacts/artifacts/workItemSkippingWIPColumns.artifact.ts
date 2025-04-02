import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';

@Injectable()
export class WorkItemSkippingWIPColumnsArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        if (!payload?.workItems || payload?.workItems?.length <= 0) {
            return;
        }

        const RECOMENDATION_LIMIT = 30; //If more than 30% of items did NOT pass through WIP columns, notify

        const doneColumnsIds = payload.columns
            .filter((column) => column.column === 'done')
            .map((col) => col.id);

        const wipColumnIds = payload.wipColumns.map((col) => col.id);

        const workItemsInDoneWithoutInProgress = payload.workItems.filter(
            (workItem) => {
                const changelog = workItem.changelog ?? [];

                const movedToDone = changelog?.some((change) =>
                    change.movements.some((movement) =>
                        doneColumnsIds.includes(movement.toColumnId),
                    ),
                );

                const passedThroughWip = changelog?.some((change) =>
                    change.movements.some(
                        (movement) =>
                            wipColumnIds.includes(movement.fromColumnId) ||
                            wipColumnIds.includes(movement.toColumnId),
                    ),
                );

                return movedToDone && !passedThroughWip;
            },
        );

        const percentageOfTasksInDoneWithoutInProgress = Math.round(
            (workItemsInDoneWithoutInProgress.length /
                payload.workItems.length) *
                100,
        );

        let percentageFormated;
        let artifactResult;

        if (percentageOfTasksInDoneWithoutInProgress > RECOMENDATION_LIMIT) {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Negative',
            );

            percentageFormated = `${percentageOfTasksInDoneWithoutInProgress}%`;
        } else {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Positive',
            );

            percentageFormated = `${(percentageOfTasksInDoneWithoutInProgress - 100) * -1}%`;
        }

        return formatResult({
            artifact: payload.artifact,
            frequenceType: payload.frequenceType,
            artifactResult: artifactResult,
            period: payload.period,
            organizationId: payload.organization.uuid,
            teamId: payload.team.uuid,
            additionalData: workItemsInDoneWithoutInProgress,
            params: [percentageFormated],
        });
    }
}
