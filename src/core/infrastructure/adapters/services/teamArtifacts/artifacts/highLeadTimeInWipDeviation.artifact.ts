import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';

@Injectable()
export class HighLeadTimeInWipDeviationArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        const RECOMENDATION_LIMIT = 50;

        const leadtimeDeviation = payload.metrics.find(
            (metric) => metric.type === METRICS_TYPE.LEAD_TIME_IN_WIP,
        )?.value.total.deviation.value;

        if (!leadtimeDeviation) {
            return;
        }

        let artifactResult;

        const leadtimeDeviationFormated = `${Math.round(leadtimeDeviation)}`;

        if (leadtimeDeviation <= RECOMENDATION_LIMIT) {
            return;
        }

        artifactResult = payload.artifact.results.find(
            (artifactResult) => artifactResult.resultType === 'Negative',
        );

        return formatResult({
            artifact: payload.artifact,
            frequenceType: payload.frequenceType,
            artifactResult: artifactResult,
            period: payload.period,
            organizationId: payload.organization.uuid,
            teamId: payload.team.uuid,
            params: [leadtimeDeviationFormated],
        });
    }
}
