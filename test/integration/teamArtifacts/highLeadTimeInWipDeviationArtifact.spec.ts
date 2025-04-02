import { TeamArtifactsModule } from '@/modules/teamArtifacts.module';
import { DatabaseModule } from '../../../src/modules/database.module';
import { Test } from '@nestjs/testing';
import { ValidationPipe, forwardRef } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { BugRatioArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/bugRatio.artifact';
import { IArtifact } from '@/core/domain/teamArtifacts/interfaces/artifact.interface';
import { ArtifactName } from '@/core/domain/teamArtifacts/enums/artifactsName.enum';
import { HighLeadTimeInWipDeviationArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/highLeadTimeInWipDeviation.artifact';
import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { DEVIATION_LEVEL } from '@/core/domain/metrics/enums/metricDeviation.enum';

describe('Calculate Bug Ratio Artifact', () => {
    let app: NestExpressApplication;
    let highLeadTimeInWipDeviation: HighLeadTimeInWipDeviationArtifact;
    let artifact: IArtifact;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                forwardRef(() => DatabaseModule),
                forwardRef(() => TeamArtifactsModule),
            ],
        }).compile();

        app = moduleRef.createNestApplication<NestExpressApplication>();
        app.useGlobalPipes(new ValidationPipe({ transform: true }));

        highLeadTimeInWipDeviation = new HighLeadTimeInWipDeviationArtifact();
        artifact =
            require('../../../src/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json').artifacts.find(
                (artifact) =>
                    artifact.name === ArtifactName.HighLeadTimeInWipDeviation,
            );
    });

    it('Should return null artifact, replacing params', async () => {
        const positivePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        positivePayload.artifact = artifact;
        positivePayload.metrics.push({
            uuid: '6a088052-6020-4deb-9c48-c34b848abf6b', // indifferent value
            value: {
                total: {
                    sum: 6609.969999999999,
                    average: 183.61,
                    deviation: { level: DEVIATION_LEVEL.LOW, value: 10 },
                    percentiles: {
                        p50: 68.184,
                        p75: 243.08,
                        p85: 243.915,
                        p95: 791.668,
                    },
                },
                issues: [],
            },
            type: METRICS_TYPE.LEAD_TIME_IN_WIP,
            team: { uuid: 'ab107268-60ab-43fa-8703-bcc187d41dc4' }, // indifferent value
            status: true,
        });

        const artifactResult =
            await highLeadTimeInWipDeviation.execute(positivePayload);

        expect(artifactResult).toBeUndefined();
    });

    it('Should return negative artifact, replacing params', async () => {
        const negativePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        negativePayload.artifact = artifact;
        negativePayload.metrics.push({
            uuid: '6a088052-6020-4deb-9c48-c34b848abf6b', // indifferent value
            value: {
                total: {
                    sum: 6609.969999999999,
                    average: 183.61,
                    deviation: { level: DEVIATION_LEVEL.HIGH, value: 93 },
                    percentiles: {
                        p50: 68.184,
                        p75: 243.08,
                        p85: 243.915,
                        p95: 791.668,
                    },
                },
                issues: [],
            },
            type: METRICS_TYPE.LEAD_TIME_IN_WIP,
            team: { uuid: 'ab107268-60ab-43fa-8703-bcc187d41dc4' }, // indifferent value
            status: true,
        });

        const artifactResult =
            await highLeadTimeInWipDeviation.execute(negativePayload);

        expect(artifactResult).toHaveProperty('name');
        expect(artifactResult).toHaveProperty('description');
        expect(artifactResult).toHaveProperty('analysisInitialDate');
        expect(artifactResult).toHaveProperty('analysisFinalDate');
        expect(artifactResult).toHaveProperty('resultType');
        expect(artifactResult).toHaveProperty('impactArea');
        expect(artifactResult).toHaveProperty('whyIsImportant');
        expect(artifactResult).toHaveProperty('teamId');
        expect(artifactResult).toHaveProperty('organizationId');
        expect(artifactResult).toHaveProperty('criticality');

        expect(artifactResult.name).toBe(
            ArtifactName.HighLeadTimeInWipDeviation,
        );
        expect(artifactResult.resultType).toBe('Negative');
        expect(artifactResult.description).toContain(
            'The lead time variation is high, with a standard deviation of 93 hours. This indicates significant inconsistencies in delivery times, which can affect process efficiency and predictability.',
        );
    });

    it('Should return null', async () => {
        const undefinedPayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        undefinedPayload.artifact = artifact;

        const artifactResult =
            await highLeadTimeInWipDeviation.execute(undefinedPayload);

        expect(artifactResult).toBeUndefined();
    });
});
