import { TeamArtifactsModule } from '@/modules/teamArtifacts.module';
import { DatabaseModule } from '../../../src/modules/database.module';
import { Test } from '@nestjs/testing';
import { ValidationPipe, forwardRef } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { BugRatioArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/bugRatio.artifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import { ITeamArtifacts } from '@/core/domain/teamArtifacts/interfaces/teamArtifacts.interface';
import { IArtifact } from '@/core/domain/teamArtifacts/interfaces/artifact.interface';
import { ArtifactName } from '@/core/domain/teamArtifacts/enums/artifactsName.enum';

describe('Calculate Bug Ratio Artifact', () => {
    let app: NestExpressApplication;
    let bugRatio: BugRatioArtifact;
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

        bugRatio = new BugRatioArtifact();
        artifact =
            require('../../../src/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json').artifacts.find(
                (artifact) => artifact.name === ArtifactName.BugRatio,
            );
    });

    it('Should return positive artifact, replacing params', async () => {
        const positivePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        positivePayload.artifact = artifact;
        positivePayload.metrics.push({
            uuid: '6a088052-6020-4deb-9c48-c34b848abf6b',
            value: { value: 0.167 },
            type: 'bugRatio',
            team: { uuid: 'ab107268-60ab-43fa-8703-bcc187d41dc4' },
            status: true,
        });

        const artifactResult = await bugRatio.execute(positivePayload);

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

        expect(artifactResult.name).toBe(ArtifactName.BugRatio);
        expect(artifactResult.resultType).toBe('Positive');
        expect(artifactResult.description).toContain(
            '17% of the items in WIP are bugs. This shows that the team is delivering with higher quality and increasing the perceived value for the user.',
        );
    });

    it('Should return negative artifact, replacing params', async () => {
        const negativePayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        negativePayload.artifact = artifact;
        negativePayload.metrics.push({
            uuid: '6a088052-6020-4deb-9c48-c34b848abf6b',
            value: { value: 0.435 },
            type: 'bugRatio',
            team: { uuid: 'ab107268-60ab-43fa-8703-bcc187d41dc4' },
            status: true,
        });

        const artifactResult = await bugRatio.execute(negativePayload);

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

        expect(artifactResult.name).toBe(ArtifactName.BugRatio);
        expect(artifactResult.resultType).toBe('Negative');
        expect(artifactResult.description).toContain(
            '44% of the items in WIP are bugs. This shows that the team is delivering with lower quality and decreasing the perceived value for the user.',
        );
    });

    it('Should return null', async () => {
        const undefinedPayload = JSON.parse(
            JSON.stringify(require('./mock/payload_default.json')),
        );
        undefinedPayload.artifact = artifact;

        const artifactResult = await bugRatio.execute(undefinedPayload);

        expect(artifactResult).toBeUndefined();
    });
});
