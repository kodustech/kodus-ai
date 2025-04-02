import { TeamArtifactsModule } from '@/modules/teamArtifacts.module';
import { DatabaseModule } from '../../../src/modules/database.module';
import { Test } from '@nestjs/testing';
import { ValidationPipe, forwardRef } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IArtifact } from '@/core/domain/teamArtifacts/interfaces/artifact.interface';
import { ArtifactName } from '@/core/domain/teamArtifacts/enums/artifactsName.enum';
import { NewBugsArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/newBugs.artifact';
import { WorkItemsStoppedInWaitingColumnsArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/workItemsStoppedInWaitingColumns.artifact';

describe('Calculate New Bugs Artifact', () => {
    let app: NestExpressApplication;
    let workItemsStoppedInWaitingColumns: WorkItemsStoppedInWaitingColumnsArtifact;
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

        workItemsStoppedInWaitingColumns =
            new WorkItemsStoppedInWaitingColumnsArtifact();
        artifact =
            require('../../../src/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json').artifacts.find(
                (artifact) =>
                    artifact.name ===
                    ArtifactName.WorkItemsStoppedInWaitingColumns,
            );
    });

    it('Should return negative artifact, replacing params', async () => {
        const negativePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );

        const allWipTasks = JSON.parse(
            JSON.stringify(
                require('./mock/allWipTasks_2InWaitingColumns.json'),
            ),
        );

        negativePayload.allWipTasks = allWipTasks;
        negativePayload.artifact = artifact;

        const artifactResult =
            await workItemsStoppedInWaitingColumns.execute(negativePayload);

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
        expect(artifactResult).toHaveProperty('additionalData');
        expect(artifactResult).toHaveProperty('frequenceType');

        expect(artifactResult.name).toBe(
            ArtifactName.WorkItemsStoppedInWaitingColumns,
        );
        expect(artifactResult.resultType).toBe('Negative');

        // Checking if the description starts with a number
        expect(/^\d+/.test(artifactResult.description)).toBe(true);

        // Verify the new message
        expect(artifactResult.description).toContain(
            '2 board items are stopped in a waiting column, this indicates that the team needs to pay more attention to items in the waiting phase to improve flow efficiency.',
        );
    });

    it('Should return null', async () => {
        const undefinedPayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        undefinedPayload.artifact = artifact;

        const artifactResult =
            await workItemsStoppedInWaitingColumns.execute(undefinedPayload);

        expect(artifactResult).toBeUndefined();
    });
});
