import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import * as moment from 'moment';
import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';

@Injectable()
export class BlockedTimeArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        const RECOMENDATION_LIMIT = 30; // If the Lead Time in waiting columns is greater than 30%, notify

        let totalBlockedMinutesAcrossAllTasks = 0;
        const impedimentTimes: {
            workItemId: string;
            totalBlockedMinutes: number;
            workItemKey: string;
        }[] = [];

        payload.workItems?.forEach((workItem: Item) => {
            let taskBlockedMinutes = 0;
            let blockedAt: moment.Moment | null = null;

            workItem.changelog?.forEach((change) => {
                change.movements.forEach((movement) => {
                    // Checks if the movement indicates the start of an impediment
                    if (
                        movement.field === 'Flagged' &&
                        movement.toColumnId === '[10019]' &&
                        !blockedAt
                    ) {
                        blockedAt = moment(change.createdAt); // Marks the start of the impediment
                    }
                    // Checks if the movement indicates the end of an impediment
                    if (
                        movement.field === 'Flagged' &&
                        movement.fromColumnId === '[10019]' &&
                        blockedAt
                    ) {
                        const unblockedAt = moment(change.createdAt);
                        taskBlockedMinutes += unblockedAt.diff(
                            blockedAt,
                            'minutes',
                        );
                        blockedAt = null; // Ends the impediment period
                    }
                });
            });

            // If still impeded at the end of the entries, consider up to the current moment
            if (blockedAt) {
                const currentTime = moment();
                taskBlockedMinutes += currentTime.diff(blockedAt, 'minutes');
            }

            if (taskBlockedMinutes > 0) {
                impedimentTimes.push({
                    workItemId: workItem.id,
                    totalBlockedMinutes: taskBlockedMinutes,
                    workItemKey: workItem.key,
                });
            }

            totalBlockedMinutesAcrossAllTasks += taskBlockedMinutes;
        });

        const totalLeadTimeInMinutes =
            payload.metrics.find(
                (metric) => metric.type === METRICS_TYPE.LEAD_TIME,
            ).value.total.sum * 60;

        const percentageOfImpediment = Math.round(
            (totalBlockedMinutesAcrossAllTasks / totalLeadTimeInMinutes) * 100,
        );

        if (percentageOfImpediment < RECOMENDATION_LIMIT) {
            return;
        }

        const blockedTimeFormated = Math.round(
            totalBlockedMinutesAcrossAllTasks / 60,
        );

        const percentageOfImpedimentFormated = `${percentageOfImpediment}%`;

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
            params: [blockedTimeFormated, percentageOfImpedimentFormated],
            additionalData: impedimentTimes,
        });
    }
}
