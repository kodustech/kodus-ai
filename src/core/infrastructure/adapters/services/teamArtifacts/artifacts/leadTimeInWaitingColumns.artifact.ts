import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';

@Injectable()
export class LeadTimeInWaitingColumnsArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        const RECOMENDATION_LIMIT = 30; // If the Lead Time in waiting columns is greater than 40%, notify

        const leadTimeByColumns = payload.metrics.find(
            (metric) => metric.type === METRICS_TYPE.LEAD_TIME_BY_COLUMN,
        )?.value;

        if (
            !payload.waitingColumns ||
            payload.waitingColumns.length <= 0 ||
            !leadTimeByColumns
        )
            return; // if there are no waiting columns, do not calculate the artifact

        const totalLeadTime = payload.metrics.find(
            (metric) => metric.type === METRICS_TYPE.LEAD_TIME,
        ).value.total.percentiles.p75;

        let totalWaitingTime = 0;

        for (const waitingColumn of payload.waitingColumns) {
            for (const column of Object.keys(leadTimeByColumns)) {
                if (column === waitingColumn.name) {
                    totalWaitingTime += leadTimeByColumns[column];
                }
            }
        }

        const percentageOfWaitingTime = Math.round(
            (totalWaitingTime / totalLeadTime) * 100,
        );

        if (isNaN(percentageOfWaitingTime)) {
            return;
        }

        const percentageOfWaitingTimeFormated = `${percentageOfWaitingTime}%`;
        let artifactResult;

        if (percentageOfWaitingTime > RECOMENDATION_LIMIT) {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Negative',
            );
        } else {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Positive',
            );
        }

        return formatResult({
            artifact: payload.artifact,
            frequenceType: payload.frequenceType,
            artifactResult: artifactResult,
            period: payload.period,
            organizationId: payload.organization.uuid,
            teamId: payload.team.uuid,
            params: [percentageOfWaitingTimeFormated],
        });
    }
}
