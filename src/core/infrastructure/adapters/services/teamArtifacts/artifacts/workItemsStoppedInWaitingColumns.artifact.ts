import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';

@Injectable()
export class WorkItemsStoppedInWaitingColumnsArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        if (
            payload.allWipTasks?.length <= 0 ||
            payload.waitingColumns?.length <= 0
        ) {
            return;
        }

        const workItemsStoppedInWaitingColumns = payload.allWipTasks.filter(
            (workItem) => {
                const now = new Date();

                const statusChanges = workItem.changelog
                    ?.flatMap((change) =>
                        change.movements
                            .filter((movement) => movement.field === 'status')
                            .map((movement) => ({
                                ...movement,
                                createdAt: change.createdAt,
                            })),
                    )
                    .sort(
                        (a, b) =>
                            new Date(b.createdAt).getTime() -
                            new Date(a.createdAt).getTime(),
                    );

                const waitingColumnIds = payload.waitingColumns.map(
                    (col) => col.id,
                );

                if (statusChanges?.length > 0) {
                    const latestStatusChange = statusChanges[0];
                    const movementTime = new Date(latestStatusChange.createdAt);
                    const hoursDiff =
                        (now.getTime() - movementTime.getTime()) /
                        1000 /
                        60 /
                        60;

                    const isCurrentlyInWaitingStatus =
                        waitingColumnIds.includes(workItem.status.id);

                    return (
                        waitingColumnIds.includes(
                            latestStatusChange.toColumnId,
                        ) &&
                        hoursDiff > 48 &&
                        isCurrentlyInWaitingStatus
                    );
                }

                return false;
            },
        );

        if (workItemsStoppedInWaitingColumns.length <= 0) {
            return;
        }

        const artifactResult = payload.artifact.results.find(
            (artifactResult) => artifactResult.resultType === 'Negative',
        );

        return formatResult({
            artifact: payload.artifact,
            frequenceType: payload.frequenceType,
            artifactResult: artifactResult,
            period: payload.period,
            organizationId: payload.organization.uuid,
            teamId: payload.team.uuid,
            params: [workItemsStoppedInWaitingColumns.length],
            additionalData: workItemsStoppedInWaitingColumns,
        });
    }
}
