import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';

@Injectable()
export class WorkItemWithAssignedOwnerArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        if (!payload?.workItems || payload?.workItems?.length <= 0) {
            return;
        }
        const RECOMENDATION_LIMIT = 30; // If more than 30% do NOT have an assignee, notify

        const tasksWithoutAssigner = payload.workItems.filter(
            (weekTask) =>
                !weekTask?.assignee &&
                payload.wipColumns?.some(
                    (column) => column.id === weekTask?.status?.id,
                ),
        );

        const percentageOfTasksWithoutAssigner = Math.round(
            (tasksWithoutAssigner.length / payload.workItems.length) * 100,
        );

        let percentageFormated;
        let artifactResult;

        if (percentageOfTasksWithoutAssigner > RECOMENDATION_LIMIT) {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Negative',
            );

            percentageFormated = `${percentageOfTasksWithoutAssigner}%`;
        } else {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Positive',
            );
            percentageFormated = `${(percentageOfTasksWithoutAssigner - 100) * -1}%`;
        }

        return formatResult({
            artifact: payload.artifact,
            frequenceType: payload.frequenceType,
            artifactResult: artifactResult,
            period: payload.period,
            organizationId: payload.organization.uuid,
            teamId: payload.team.uuid,
            additionalData: { tasksWithoutAssigner },
            params: [percentageFormated],
        });
    }
}
