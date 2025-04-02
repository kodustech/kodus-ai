import { TeamArtifactsModule } from '@/modules/teamArtifacts.module';
import { DatabaseModule } from '../../../src/modules/database.module';
import { Test } from '@nestjs/testing';
import { ValidationPipe, forwardRef } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { BugRatioArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/bugRatio.artifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import { ITeamArtifacts } from '@/core/domain/teamArtifacts/interfaces/teamArtifacts.interface';
import { IArtifact } from '@/core/domain/teamArtifacts/interfaces/artifact.interface';
import { LeadTimeInWaitingColumnsArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/leadTimeInWaitingColumns.artifact';
import { ArtifactName } from '@/core/domain/teamArtifacts/enums/artifactsName.enum';

describe('Calculate Lead Time In Waiting Columns Artifact', () => {
    let app: NestExpressApplication;
    let LeadTimeInWaitingColumns: LeadTimeInWaitingColumnsArtifact;
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

        LeadTimeInWaitingColumns = new LeadTimeInWaitingColumnsArtifact();
        artifact =
            require('../../../src/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json').artifacts.find(
                (artifact) =>
                    artifact.name === ArtifactName.LeadTimeInWaitingColumns,
            );
    });

    it('Should return positive artifact, replacing params', async () => {
        const positivePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        positivePayload.artifact = artifact;

        positivePayload.metrics.push({
            uuid: 'f26851c8-cda5-4364-893d-9d94f2ae90b6',
            value: {
                'Ready To Do': 40.758,
                'In Progress': 47.917,
                'Waiting For Homolog': 2.974,
                'In Homolog': 89.701,
                'Ready To Deploy': 20.197,
            },
            type: 'leadTimeByColumn',
            team: { uuid: 'ab107268-60ab-43fa-8703-bcc187d41dc4' },
            status: true,
        });

        positivePayload.metrics.push({
            uuid: 'a6736027-565e-4243-8dc6-fefdd72b1828',
            value: {
                columns: [
                    {
                        column: 'Ready To Do',
                        average: 35.6,
                        percentile: {
                            p50: 9.874,
                            p75: 40.758,
                            p85: 72.601,
                            p95: 143.321,
                        },
                    },
                ],
                total: {
                    average: 289.796,
                    percentiles: {
                        p50: 208.089,
                        p75: 459.772,
                        p85: 553.091,
                        p95: 743.374,
                    },
                },
            },
            type: 'leadTime',
            team: { uuid: 'ab107268-60ab-43fa-8703-bcc187d41dc4' },
            status: true,
        });

        const artifactResult =
            await LeadTimeInWaitingColumns.execute(positivePayload);

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
        expect(artifactResult).toHaveProperty('frequenceType');

        expect(artifactResult.name).toBe(ArtifactName.LeadTimeInWaitingColumns);
        expect(artifactResult.resultType).toBe('Positive');
        expect(artifactResult.description).toContain(
            '5% of the lead time was spent in waiting stages, you are maximizing efficiency and avoiding unnecessary delays in the process.',
        );
    });

    it('Should return negative artifact, replacing params', async () => {
        const positivePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        positivePayload.artifact = artifact;

        positivePayload.metrics.push({
            uuid: 'f26851c8-cda5-4364-893d-9d94f2ae90b6',
            value: {
                'Ready To Do': 40.758,
                'In Progress': 47.917,
                'Waiting For Homolog': 2.974,
                'In Homolog': 89.701,
                'Ready To Deploy': 200.197,
            },
            type: 'leadTimeByColumn',
            team: { uuid: 'ab107268-60ab-43fa-8703-bcc187d41dc4' },
            status: true,
        });

        positivePayload.metrics.push({
            uuid: 'a6736027-565e-4243-8dc6-fefdd72b1828',
            value: {
                columns: [
                    {
                        column: 'Ready To Do',
                        average: 35.6,
                        percentile: {
                            p50: 9.874,
                            p75: 40.758,
                            p85: 72.601,
                            p95: 143.321,
                        },
                    },
                ],
                total: {
                    average: 289.796,
                    percentiles: {
                        p50: 208.089,
                        p75: 459.772,
                        p85: 553.091,
                        p95: 743.374,
                    },
                },
            },
            type: 'leadTime',
            team: { uuid: 'ab107268-60ab-43fa-8703-bcc187d41dc4' },
            status: true,
        });

        const artifactResult =
            await LeadTimeInWaitingColumns.execute(positivePayload);

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

        expect(artifactResult.name).toBe(ArtifactName.LeadTimeInWaitingColumns);
        expect(artifactResult.resultType).toBe('Negative');
        expect(artifactResult.description).toContain(
            '44% of the lead time was spent in waiting stages, you are minimizing efficiency and causing unnecessary delays in the process.',
        );
    });

    it('Should return null', async () => {
        const undefinedPayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        undefinedPayload.artifact = artifact;

        const artifactResult =
            await LeadTimeInWaitingColumns.execute(undefinedPayload);

        expect(artifactResult).toBeUndefined();
    });
});
