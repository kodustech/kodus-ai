import { TeamArtifactsModule } from '@/modules/teamArtifacts.module';
import { DatabaseModule } from '../../../src/modules/database.module';
import { Test } from '@nestjs/testing';
import { ValidationPipe, forwardRef } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { IArtifact } from '@/core/domain/teamArtifacts/interfaces/artifact.interface';
import { ArtifactName } from '@/core/domain/teamArtifacts/enums/artifactsName.enum';
import { HighWorkloadPerPersonArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/highWorkloadPerPerson.artifact';

describe('Calculate High Workload Per Person Artifact', () => {
    let app: NestExpressApplication;
    let highWorkloadPerPersonByGitHub: HighWorkloadPerPersonArtifact;
    let highWorkloadPerPersonByGitLab: HighWorkloadPerPersonArtifact;
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

        highWorkloadPerPersonByGitHub = new HighWorkloadPerPersonArtifact();
        highWorkloadPerPersonByGitLab = new HighWorkloadPerPersonArtifact();

        artifact =
            require('../../../src/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json').artifacts.find(
                (artifact) =>
                    artifact.name === ArtifactName.HighWorkloadPerPerson,
            );
    });

    it('Should accurately calculate workload for GitHub data', async () => {
        const payload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );

        const workloadDataGitHub = JSON.parse(
            JSON.stringify(require('./mock/highWorkloadPerPerson_github.json')),
        );

        payload.commitsByUser = workloadDataGitHub;
        payload.period.endDate = '2024-06-28 09:00';
        payload.artifact = artifact;

        const artifactResultGitHub =
            await highWorkloadPerPersonByGitHub.execute(payload);

        expect(artifactResultGitHub[0]).toHaveProperty('name');
        expect(artifactResultGitHub[0]).toHaveProperty('description');
        expect(artifactResultGitHub[0]).toHaveProperty('analysisInitialDate');
        expect(artifactResultGitHub[0]).toHaveProperty('analysisFinalDate');
        expect(artifactResultGitHub[0]).toHaveProperty('resultType');
        expect(artifactResultGitHub[0]).toHaveProperty('impactArea');
        expect(artifactResultGitHub[0]).toHaveProperty('whyIsImportant');
        expect(artifactResultGitHub[0]).toHaveProperty('teamId');
        expect(artifactResultGitHub[0]).toHaveProperty('organizationId');
        expect(artifactResultGitHub[0]).toHaveProperty('criticality');
        expect(artifactResultGitHub[0]).toHaveProperty(
            'additionalInfoFormated',
        );
        expect(artifactResultGitHub[0]).toHaveProperty('frequenceType');

        expect(artifactResultGitHub[0].name).toBe(
            ArtifactName.HighWorkloadPerPerson,
        );
        expect(artifactResultGitHub[0].resultType).toBe('Negative');
        expect(artifactResultGitHub[0].description).toContain(
            'There are indications of a high workload for the team member: Junior Sartori.',
        );
    });

    it('Should accurately calculate workload for GitLab data', async () => {
        const payload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );

        const workloadDataGitLab = JSON.parse(
            JSON.stringify(require('./mock/highWorkloadPerPerson_gitlab.json')),
        );

        payload.commitsByUser = workloadDataGitLab;
        payload.period.endDate = '2024-06-28 09:00';
        payload.artifact = artifact;

        const artifactResultGitLab =
            await highWorkloadPerPersonByGitLab.execute(payload);

        expect(artifactResultGitLab[0]).toHaveProperty('name');
        expect(artifactResultGitLab[0]).toHaveProperty('description');
        expect(artifactResultGitLab[0]).toHaveProperty('analysisInitialDate');
        expect(artifactResultGitLab[0]).toHaveProperty('analysisFinalDate');
        expect(artifactResultGitLab[0]).toHaveProperty('resultType');
        expect(artifactResultGitLab[0]).toHaveProperty('impactArea');
        expect(artifactResultGitLab[0]).toHaveProperty('whyIsImportant');
        expect(artifactResultGitLab[0]).toHaveProperty('teamId');
        expect(artifactResultGitLab[0]).toHaveProperty('organizationId');
        expect(artifactResultGitLab[0]).toHaveProperty('criticality');
        expect(artifactResultGitLab[0]).toHaveProperty(
            'additionalInfoFormated',
        );
        expect(artifactResultGitLab[0]).toHaveProperty('frequenceType');

        expect(artifactResultGitLab[0].name).toBe(
            ArtifactName.HighWorkloadPerPerson,
        );
        expect(artifactResultGitLab[0].resultType).toBe('Negative');
        expect(artifactResultGitLab[0].description).toContain(
            'There are indications of a high workload for the team member: Junior Sartori.',
        );
    });

    it('Should return null', async () => {
        const undefinedPayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        undefinedPayload.artifact = artifact;

        const artifactResultGitHub =
            await highWorkloadPerPersonByGitHub.execute(undefinedPayload);

        expect(artifactResultGitHub).toBeUndefined();
    });

    it('Should return null', async () => {
        const undefinedPayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        undefinedPayload.artifact = artifact;

        const artifactResultGitLab =
            await highWorkloadPerPersonByGitLab.execute(undefinedPayload);

        expect(artifactResultGitLab).toBeUndefined();
    });
});
