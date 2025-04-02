import { TeamArtifactsModule } from '@/modules/teamArtifacts.module';
import { DatabaseModule } from '../../../src/modules/database.module';
import { Test } from '@nestjs/testing';
import { ValidationPipe, forwardRef } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { BugRatioArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/bugRatio.artifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import { ITeamArtifacts } from '@/core/domain/teamArtifacts/interfaces/teamArtifacts.interface';
import { IArtifact } from '@/core/domain/teamArtifacts/interfaces/artifact.interface';
import { WithoutWaitingColumnsArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/withoutWaitingColumns.artifact';
import { ArtifactName } from '@/core/domain/teamArtifacts/enums/artifactsName.enum';

describe('Calculate Waiting Columns Artifact', () => {
    let app: NestExpressApplication;
    let withoutWaitingColumns: WithoutWaitingColumnsArtifact;
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

        withoutWaitingColumns = new WithoutWaitingColumnsArtifact();
        artifact =
            require('../../../src/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json').artifacts.find(
                (artifact) =>
                    artifact.name === ArtifactName.WithoutWaitingColumns,
            );
    });

    it('Should return negative artifact, replacing params', async () => {
        const negativePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        negativePayload.artifact = artifact;

        negativePayload.waitingColumns = [];

        const artifactResult =
            await withoutWaitingColumns.execute(negativePayload);

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

        expect(artifactResult.name).toBe(ArtifactName.WithoutWaitingColumns);
        expect(artifactResult.resultType).toBe('Negative');
        expect(artifactResult.description).toContain(
            'No waiting columns were identified on your board, which can make it difficult to identify gaps in the process. Analyze your board and identify unmapped waiting stages.',
        );
    });

    it('Should return null', async () => {
        const undefinedPayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        undefinedPayload.artifact = artifact;

        const artifactResult =
            await withoutWaitingColumns.execute(undefinedPayload);

        expect(artifactResult).toBeUndefined();
    });
});
