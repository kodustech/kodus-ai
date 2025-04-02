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
import { WorkItemSkippingWIPColumnsArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/workItemSkippingWIPColumns.artifact';

describe('Calculate Work Item Skipping WIP Artifact', () => {
    let app: NestExpressApplication;
    let workItemsSkippingColumns: WorkItemSkippingWIPColumnsArtifact;
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

        workItemsSkippingColumns = new WorkItemSkippingWIPColumnsArtifact();
        artifact =
            require('../../../src/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json').artifacts.find(
                (artifact) =>
                    artifact.name === ArtifactName.WorkItemSkippingWIPColumns,
            );
    });

    it('Should return positive artifact, replacing params', async () => {
        const positivePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        positivePayload.artifact = artifact;
        positivePayload.workItems = JSON.parse(
            JSON.stringify(require('./mock/workItems.json').workItems),
        );

        const artifactResult =
            await workItemsSkippingColumns.execute(positivePayload);

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

        expect(artifactResult.name).toBe(
            ArtifactName.WorkItemSkippingWIPColumns,
        );
        expect(artifactResult.resultType).toBe('Positive');
        expect(artifactResult.description).toContain(
            "100% of the board items that were completed passed through the WIP columns. This indicates that the team is respecting the board's flow.",
        );
    });

    it('Should return negative artifact, replacing params', async () => {
        const negativePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        negativePayload.artifact = artifact;
        negativePayload.workItems = JSON.parse(
            JSON.stringify(
                require('./mock/workItems_skippingWIP.json').workItems,
            ),
        );

        const artifactResult =
            await workItemsSkippingColumns.execute(negativePayload);

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
            ArtifactName.WorkItemSkippingWIPColumns,
        );
        expect(artifactResult.resultType).toBe('Negative');
        expect(artifactResult.description).toContain(
            '80% of the board items that were completed did not pass through any WIP column. This indicates that the team is not respecting the flow, which affects metrics like Lead Time, WIP, and complicates delivery projections.',
        );
    });

    it('Should return null', async () => {
        const undefinedPayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        undefinedPayload.artifact = artifact;

        const artifactResult =
            await workItemsSkippingColumns.execute(undefinedPayload);

        expect(artifactResult).toBeUndefined();
    });
});
