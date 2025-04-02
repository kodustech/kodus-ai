import { PullRequestCodeReviewTime } from '@/core/domain/platformIntegrations/types/codeManagement/pullRequests.type';
import { IArtifact } from '@/core/domain/teamArtifacts/interfaces/artifact.interface';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import { CodeReviewTimeToMergeArtifact } from '@/core/infrastructure/adapters/services/teamArtifacts/artifacts/codeReviewTimeToMerge.artifact';
import { formatResult } from '@/core/infrastructure/adapters/services/teamArtifacts/formatArtifact';
import { DatabaseModule } from '@/modules/database.module';
import { TeamArtifactsModule } from '@/modules/teamArtifacts.module';
import { forwardRef, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';

jest.mock(
    '@/core/infrastructure/adapters/services/teamArtifacts/formatArtifact',
);

describe('CodeReviewTimeToMergeArtifact', () => {
    let app: NestExpressApplication;

    let codeReviewTimeToMergeArtifact: CodeReviewTimeToMergeArtifact;

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

        codeReviewTimeToMergeArtifact = new CodeReviewTimeToMergeArtifact();
        artifact =
            require('../../../src/core/infrastructure/adapters/services/teamArtifacts/artifactsStructure.json').artifacts.find(
                (artifact) => artifact.name === 'CodeReviewTimeToMerge',
            );
    });

    describe('execute', () => {
        it('should return if pullRequestsForRTTM is not provided', () => {
            const payload: IArtifacExecutiontPayload = {
                artifact: {
                    artifactConfigs: {},
                    results: [],
                },
                pullRequestsForRTTM: null,
                frequenceType: '',
                period: '',
                organization: { uuid: 'org1' },
                team: { uuid: 'team1' },
            } as any;

            const result = codeReviewTimeToMergeArtifact.execute(payload);

            expect(result).toBeUndefined();
        });

        it('should process the payload correctly', () => {
            const payload: IArtifacExecutiontPayload = {
                artifact: {
                    artifactConfigs: {
                        timeLimitForReview: 1,
                        recommendationLimit: 0.3,
                    },
                    results: [
                        { resultType: 'Negative' },
                        { resultType: 'Positive' },
                    ],
                },
                pullRequestsForRTTM: [
                    {
                        id: 311842375,
                        created_at: '2024-06-28T20:04:31.489Z',
                        closed_at: '2024-06-28T20:04:37.179Z',
                    },
                    {
                        id: 311834284,
                        created_at: '2024-06-28T19:01:56.880Z',
                        closed_at: '2024-06-28T19:02:07.126Z',
                    },
                    {
                        id: 311753790,
                        created_at: '2024-06-28T12:10:33.329Z',
                        closed_at: '2024-06-28T12:10:47.148Z',
                    },
                ],
                frequenceType: 'monthly',
                period: '2024-06',
                organization: { uuid: 'org1' },
                team: { uuid: 'team1' },
            } as any;

            const result = codeReviewTimeToMergeArtifact.execute(payload);

            expect(formatResult).toHaveBeenCalledWith(
                expect.objectContaining({
                    artifact: payload.artifact,
                    frequenceType: payload.frequenceType,
                    artifactResult: expect.any(Object),
                    period: payload.period,
                    organizationId: payload.organization.uuid,
                    teamId: payload.team.uuid,
                    params: expect.arrayContaining([expect.any(String), 1]),
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
                pullRequestsForRTTM: [
                    {
                        id: 311842375,
                        created_at: '2024-06-28T20:04:31.489Z',
                        closed_at: '2024-06-28T20:04:37.179Z',
                    },
                ],
                frequenceType: 'monthly',
                period: '2024-06',
                organization: { uuid: 'org1' },
                team: { uuid: 'team1' },
            } as any;

            const result = codeReviewTimeToMergeArtifact.execute(payload);

            expect(formatResult).toHaveBeenCalled();
        });

        it('should handle empty pullRequestsForRTTM', () => {
            const payload: IArtifacExecutiontPayload = {
                artifact: {
                    artifactConfigs: {
                        timeLimitForReview: 1,
                        recommendationLimit: 0.3,
                    },
                    results: [
                        { resultType: 'Negative' },
                        { resultType: 'Positive' },
                    ],
                },
                pullRequestsForRTTM: [],
                frequenceType: 'monthly',
                period: '2024-06',
                organization: { uuid: 'org1' },
                team: { uuid: 'team1' },
            } as any;

            const result = codeReviewTimeToMergeArtifact.execute(payload);

            expect(result).toBeUndefined();
        });

        it('should handle null values in pullRequestsForRTTM', () => {
            const payload: IArtifacExecutiontPayload = {
                artifact: {
                    artifactConfigs: {
                        timeLimitForReview: 1,
                        recommendationLimit: 0.3,
                    },
                    results: [
                        { resultType: 'Negative' },
                        { resultType: 'Positive' },
                    ],
                },
                pullRequestsForRTTM: [
                    {
                        id: 311842375,
                        created_at: null,
                        closed_at: '2024-06-28T20:04:37.179Z',
                    },
                    {
                        id: 311834284,
                        created_at: '2024-06-28T19:01:56.880Z',
                        closed_at: null,
                    },
                ],
                frequenceType: 'monthly',
                period: '2024-06',
                organization: { uuid: 'org1' },
                team: { uuid: 'team1' },
            } as any;

            const result = codeReviewTimeToMergeArtifact.execute(payload);

            expect(formatResult).toHaveBeenCalledWith(
                expect.objectContaining({
                    artifact: payload.artifact,
                    frequenceType: payload.frequenceType,
                    artifactResult: expect.any(Object),
                    period: payload.period,
                    organizationId: payload.organization.uuid,
                    teamId: payload.team.uuid,
                    params: expect.arrayContaining([expect.any(String), 1]),
                }),
            );
        });
    });

    describe('calculateRTTM', () => {
        it('should calculate review time correctly', () => {
            const pullRequestsForRTTM = [
                {
                    id: 311842375,
                    created_at: '2024-06-28T20:04:31.489Z',
                    closed_at: '2024-06-28T20:04:37.179Z',
                },
                {
                    id: 311834284,
                    created_at: '2024-06-28T19:01:56.880Z',
                    closed_at: '2024-06-28T19:02:07.126Z',
                },
                {
                    id: 311753790,
                    created_at: '2024-06-28T12:10:33.329Z',
                    closed_at: '2024-06-28T12:10:47.148Z',
                },
            ];

            const expectedResult = [
                { id: 311842375, reviewTime: 0.00158027778 },
                { id: 311834284, reviewTime: 0.00284611111 },
                { id: 311753790, reviewTime: 0.00383861111 },
            ];

            const result =
                codeReviewTimeToMergeArtifact.calculateRTTM(
                    pullRequestsForRTTM,
                );

            // Compare each item individually to ensure accuracy
            expect(result.length).toBe(expectedResult.length);
            result.forEach((res, index) => {
                expect(res.id).toBe(expectedResult[index].id);
                expect(res.reviewTime).toBeCloseTo(
                    expectedResult[index].reviewTime,
                    5,
                ); // Adjust precision as needed
            });
        });

        it('should handle null values in pullRequestCodeReviewTime', () => {
            const pullRequestsForRTTM = [
                {
                    id: 311842375,
                    created_at: null,
                    closed_at: '2024-06-28T20:04:37.179Z',
                },
                {
                    id: 311834284,
                    created_at: '2024-06-28T19:01:56.880Z',
                    closed_at: null,
                },
            ];

            const result =
                codeReviewTimeToMergeArtifact.calculateRTTM(
                    pullRequestsForRTTM,
                );

            // We expect an empty array, as both PRs have null values
            expect(result).toEqual([]);
        });

        it('should handle empty pullRequestCodeReviewTime', () => {
            const pullRequestsForRTTM: PullRequestCodeReviewTime[] = [];

            const result =
                codeReviewTimeToMergeArtifact.calculateRTTM(
                    pullRequestsForRTTM,
                );

            expect(result).toEqual([]);
        });
    });

    describe('calculateMetrics', () => {
        it('should calculate metrics correctly', () => {
            const reviewTimes = [
                { id: 311842375, reviewTime: 0.5 },
                { id: 311834284, reviewTime: 2 },
                { id: 311753790, reviewTime: 1.5 },
            ];
            const timeToReview = 1;

            const expectedResult = {
                averageTime: 1.3333333333333333,
                exceedingCount: 2,
                exceedingCodeReviewTimePercentage: 0.6666666666666666,
            };

            const result = codeReviewTimeToMergeArtifact.calculateMetrics(
                reviewTimes,
                timeToReview,
            );

            expect(result).toEqual(expectedResult);
        });
    });
});
