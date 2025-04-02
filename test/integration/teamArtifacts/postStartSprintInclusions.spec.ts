import { TeamArtifactsModule } from '@/modules/teamArtifacts.module';
import { DatabaseModule } from '../../../src/modules/database.module';
import { Test } from '@nestjs/testing';
import { ValidationPipe, forwardRef } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IArtifact } from '@/core/domain/teamArtifacts/interfaces/artifact.interface';
import { ArtifactName } from '@/core/domain/teamArtifacts/enums/artifactsName.enum';
import { NewBugsArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/newBugs.artifact';
import { PostStartSprintInclusionsArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/postStartSprintInclusions.artifacts';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import {
    currentSprint,
    workItemsForCurrentSprint,
} from 'test/mocks/data/sprints';
import { moduleWorkItems } from 'test/mocks/data/moduleWorkItems';
import { bugTypeIdentifiers } from 'test/mocks/data/bugTypeIdentifier';
import { STATUS } from '@/config/types/database/status.type';

describe('Calculate Post Sprint Start Inclusion Artifact', () => {
    let app: NestExpressApplication;
    let postStartInclusion: PostStartSprintInclusionsArtifact;
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

        postStartInclusion = new PostStartSprintInclusionsArtifact();
        artifact =
            require('../../../src/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json').artifacts.find(
                (artifact) =>
                    artifact.name ===
                    ArtifactName.PostStartSprintInclusionsArtifact,
            );
    });

    it('Should return negative artifact, replacing params', async () => {
        const payload: IArtifacExecutiontPayload = {
            frequenceType: 'weekly',
            artifact: artifact,
            sprints: {
                currentSprint: currentSprint(),
            },
            workItems: workItemsForCurrentSprint(),
            bugTypeIdentifiers: bugTypeIdentifiers(),
            workItemTypes: moduleWorkItems(),
            workItemsDescriptionQuality: {
                score: 0,
                dataAnalyzed: undefined,
            },
            newBugsInTheLast24Hours: [],
            allWipTasks: [],
            nextSprintWorkItems: [],
            team: {
                name: 'Team Name',
                uuid: 'ab107268-60ab-43fa-8703-bcc187d41dc4',
                status: STATUS.ACTIVE,
            },
            organization: {
                uuid: '29c7385e-ece9-44e7-a881-7eba00f88beb',
                name: 'Name',
                tenantName: 'Name',
                status: true,
            },
            period: {
                startDate: new Date('2024-02-28 00:14'),
                endDate: new Date('2024-03-06 00:14'),
            },
            commitsByUser: [],
        };

        const artifactResult = await postStartInclusion.execute(payload);

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
            ArtifactName.PostStartSprintInclusionsArtifact,
        );
        expect(artifactResult.resultType).toBe('Negative');
        expect(artifactResult.description).toContain(
            '3 items were identified as added after the start of the sprint. This can complicate meeting sprint goals due to possible overload or focus deviation.',
        );
    });

    it('Should return null', async () => {
        const undefinedPayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        undefinedPayload.artifact = artifact;

        const artifactResult =
            await postStartInclusion.execute(undefinedPayload);

        expect(artifactResult).toBeUndefined();
    });
});
