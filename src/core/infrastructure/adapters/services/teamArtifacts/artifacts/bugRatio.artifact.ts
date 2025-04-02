import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';

@Injectable()
export class BugRatioArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        const RECOMENDATION_LIMIT = 0.4; // If the bug ratio is greater than 40%, notify

        const bugRatio = payload.metrics.find(
            (metric) => metric.type === METRICS_TYPE.BUG_RATIO,
        )?.value?.value;

        if (!bugRatio) {
            return;
        }

        let artifactResult;

        const bugRatioFormated = `${Math.round(bugRatio * 100)}%`;

        if (bugRatio > RECOMENDATION_LIMIT) {
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
            params: [bugRatioFormated],
        });
    }
}
