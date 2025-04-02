import { ArtifactName } from '@/core/domain/teamArtifacts/enums/artifactsName.enum';
import { IArtifact } from '@/core/domain/teamArtifacts/interfaces/artifact.interface';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import { PullRequestWithSizeGreaterThanLimitArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/pullRequestWithSizeGreaterThanLimit.artifact';
import { formatResult } from '@/core/infrastructure/adapters/services/teamArtifacts/formatArtifact';
import { DatabaseModule } from '@/modules/database.module';
import { TeamArtifactsModule } from '@/modules/teamArtifacts.module';
import { forwardRef, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';

jest.mock(
    '@/core/infrastructure/adapters/services/teamArtifacts/formatArtifact',
);

describe('PullRequestWithSizeGreaterThanLimitArtifact', () => {
    let app: NestExpressApplication;

    let pullRequestWithSizeGreaterThanLimit: PullRequestWithSizeGreaterThanLimitArtifact;

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

        pullRequestWithSizeGreaterThanLimit =
            new PullRequestWithSizeGreaterThanLimitArtifact();
        artifact =
            require('../../../src/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json').artifacts.find(
                (artifact) =>
                    artifact.name ===
                    ArtifactName.PullRequestWithSizeGreaterThanLimit,
            );
    });

    describe('execute', () => {
        it('should return if pullRequestsWithFiles is not provided', () => {
            const payload: IArtifacExecutiontPayload = {
                artifact: {
                    artifactConfigs: {},
                    results: [],
                },
                pullRequestsWithFiles: null,
                frequenceType: '',
                period: '',
                organization: { uuid: 'org1' },
                team: { uuid: 'team1' },
            } as any;

            const result = pullRequestWithSizeGreaterThanLimit.execute(payload);

            expect(result).toBeUndefined();
        });

        it('should process the payload correctly', () => {
            const payload: IArtifacExecutiontPayload = {
                artifact: {
                    artifactConfigs: {
                        recommendationLimit: 0.3,
                        pullRequestSizeLimit: 400,
                    },
                    results: [
                        { resultType: 'Negative' },
                        { resultType: 'Positive' },
                    ],
                },
                pullRequestsWithFiles: [
                    {
                        id: 311842375,
                        state: 'merged',
                        title: 'Update file index.js',
                        repository: 'Kodus / teste',
                        pullRequestFiles: [{ changes: 51 }],
                    },
                    {
                        id: 311834284,
                        state: 'merged',
                        title: 'Update 3 files',
                        repository: 'Kodus / teste',
                        pullRequestFiles: [
                            { changes: 18 },
                            { changes: 30 },
                            { changes: 71 },
                        ],
                    },
                    {
                        id: 311753790,
                        state: 'merged',
                        title: 'Update README.md',
                        repository: 'Kodus / teste',
                        pullRequestFiles: [{ changes: 2 }],
                    },
                ],
                frequenceType: 'monthly',
                period: '2022-08',
                organization: { uuid: 'org1' },
                team: { uuid: 'team1' },
            } as any;

            const result = pullRequestWithSizeGreaterThanLimit.execute(payload);

            expect(formatResult).toHaveBeenCalledWith(
                expect.objectContaining({
                    artifact: payload.artifact,
                    frequenceType: payload.frequenceType,
                    artifactResult: expect.any(Object),
                    period: payload.period,
                    organizationId: payload.organization.uuid,
                    teamId: payload.team.uuid,
                    params: expect.arrayContaining([expect.any(String), 400]),
                }),
            );
        });

        it('should handle missing artifactConfigs gracefully', () => {
            const payload: IArtifacExecutiontPayload = {
                artifact: {
                    artifactConfigs: null,
                    results: [
                        { resultType: 'Negative' },
                        { resultType: 'Positive' },
                    ],
                },
                pullRequestsWithFiles: [
                    {
                        id: 311842375,
                        state: 'merged',
                        title: 'Update file index.js',
                        repository: 'Kodus / teste',
                        pullRequestFiles: [{ changes: 51 }],
                    },
                ],
                frequenceType: 'monthly',
                period: '2022-08',
                organization: { uuid: 'org1' },
                team: { uuid: 'team1' },
            } as any;

            const result = pullRequestWithSizeGreaterThanLimit.execute(payload);

            expect(formatResult).toHaveBeenCalled();
        });
    });

    describe('validatePullRequestSize', () => {
        it('should validate pull requests correctly', () => {
            const pullRequestsWithFiles = [
                {
                    id: 311842375,
                    pullRequestFiles: [{ changes: 51 }],
                },
                {
                    id: 311834284,
                    pullRequestFiles: [
                        { changes: 18 },
                        { changes: 30 },
                        { changes: 71 },
                    ],
                },
                {
                    id: 311753790,
                    pullRequestFiles: [{ changes: 2 }],
                },
                {
                    id: 311753795,
                    pullRequestFiles: [{ changes: 450 }],
                },
                {
                    id: 311753798,
                    pullRequestFiles: [
                        { changes: 450 },
                        { changes: 100 },
                        { changes: 50 },
                        { changes: 142 },
                    ],
                },
            ] as any;

            const maxChanges = 400;
            const validationResult =
                pullRequestWithSizeGreaterThanLimit.validatePullRequestSize(
                    pullRequestsWithFiles,
                    maxChanges,
                );

            expect(validationResult).toEqual([
                { pullRequestId: 311842375, isValid: true, totalChanges: 51 },
                { pullRequestId: 311834284, isValid: true, totalChanges: 119 },
                { pullRequestId: 311753790, isValid: true, totalChanges: 2 },
                { pullRequestId: 311753795, isValid: false, totalChanges: 450 },
                { pullRequestId: 311753798, isValid: false, totalChanges: 742 },
            ]);
        });

        it('should handle pull requests with empty pullRequestFiles correctly', () => {
            const pullRequestsWithFiles = [
                {
                    id: 311842375,
                    pullRequestFiles: [],
                },
                {
                    id: 311834284,
                    pullRequestFiles: null,
                },
            ] as any;

            const maxChanges = 400;
            const validationResult =
                pullRequestWithSizeGreaterThanLimit.validatePullRequestSize(
                    pullRequestsWithFiles,
                    maxChanges,
                );

            expect(validationResult).toEqual([
                { pullRequestId: 311842375, isValid: true, totalChanges: 0 },
                { pullRequestId: 311834284, isValid: true, totalChanges: 0 },
            ]);
        });
    });
});
