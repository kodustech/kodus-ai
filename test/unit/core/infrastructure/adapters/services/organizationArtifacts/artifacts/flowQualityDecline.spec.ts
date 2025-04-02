import { FlowQualityDeclineArtifact } from '@/core/infrastructure/adapters/services/organizationArtifacts/artifacts/flowQualityDecline.artifact';
import { organizationTeamFormatResult } from '@/core/infrastructure/adapters/services/organizationArtifacts/organizationFormatArtifact';

jest.mock('@/shared/utils/helpers', () => ({
    checkArtifactActiveForTeam: jest.fn(),
}));
jest.mock(
    '@/core/infrastructure/adapters/services/organizationArtifacts/organizationFormatArtifact',
    () => {
        const originalModule = jest.requireActual(
            '@/core/infrastructure/adapters/services/organizationArtifacts/organizationFormatArtifact',
        );
        return {
            ...originalModule,
            organizationFormatResult: jest.fn(),
            organizationTeamFormatResult: jest.fn(),
        };
    },
);

describe('flowQualityDeclineArtifact execute function tests', () => {
    let flowQualityDeclineArtifact = null;

    beforeAll(() => {
        flowQualityDeclineArtifact = new FlowQualityDeclineArtifact();
    });

    afterEach(() => {
        // Restore the original method after each test
        jest.restoreAllMocks();
        (organizationTeamFormatResult as jest.Mock).mockClear();
    });

    test('execute should return null if no team artifacts meet the criteria', () => {
        // Setup the mock to return false for checkArtifactActiveForTeam
        require('@/shared/utils/helpers').checkArtifactActiveForTeam.mockReturnValue(
            false,
        );

        const organizationArtifact = {
            teamMethodology: ['Scrum', 'Kanban'],
            results: [{ resultType: 'Negative', details: 'Sample Detail' }],
        };
        const payload = [
            {
                teamMethodology: 'Scrum',
                period: '2021-W14',
                organizationAndTeamData: {
                    organizationId: 'org1',
                    teamId: 'team1',
                },
                teamArtifacts: {
                    mostRecentArtifacts: {
                        date: '2021-04-06',
                        artifacts: [
                            {
                                resultType: 'Negative',
                                details: 'Issue in deployment',
                            },
                        ],
                    },
                    previousArtifacts: [
                        {
                            date: '2021-03-30',
                            artifacts: [
                                {
                                    resultType: 'Negative',
                                    details: 'Issue in testing',
                                },
                            ],
                        },
                    ],
                },
            },
        ];

        // Execute the function with the mock data
        const result = flowQualityDeclineArtifact.execute(
            organizationArtifact,
            payload,
        );

        // Expect the result to be null
        expect(result).toBeNull();
        // Ensure the format result function is not called
        expect(
            require('@/core/infrastructure/adapters/services/organizationArtifacts/organizationFormatArtifact')
                .organizationFormatResult,
        ).not.toHaveBeenCalled();
    });

    it('should handle standard input correctly', () => {
        const organizationArtifact = {
            teamMethodology: ['Scrum', 'Kanban'],
            results: [{ resultType: 'Negative', details: 'Sample Detail' }],
        };
        const payload = [
            {
                teamMethodology: 'Scrum',
                period: '2021-W14',
                organizationAndTeamData: {
                    organizationId: 'org1',
                    teamId: 'team1',
                },
                teamArtifacts: {
                    mostRecentArtifacts: {
                        date: '2021-04-06',
                        artifacts: [
                            {
                                resultType: 'Negative',
                                details: 'Issue in deployment',
                            },
                        ],
                    },
                    previousArtifacts: [
                        {
                            date: '2021-03-30',
                            artifacts: [
                                {
                                    resultType: 'Negative',
                                    details: 'Issue in testing',
                                },
                            ],
                        },
                    ],
                },
            },
        ];

        const result = flowQualityDeclineArtifact.execute(
            organizationArtifact,
            payload,
        );
        expect(result).toBeDefined();
    });

    // Test for methodology mismatches
    it('should return null for methodology mismatches', () => {
        const organizationArtifact = { teamMethodology: ['XP'] };
        const payload = [{ teamMethodology: 'Scrum' }];

        const result = flowQualityDeclineArtifact.execute(
            organizationArtifact,
            payload,
        );
        expect(result).toBeNull();
    });

    //Test for incomplete or malformed data
    it('should handle incomplete data', () => {
        const organizationArtifact = { teamMethodology: ['Scrum'] };
        const payload = [{}]; // Missing necessary fields

        const result = flowQualityDeclineArtifact.execute(
            organizationArtifact,
            payload,
        );
        expect(result).toBeNull();
    });

    //Test for zero negative artifacts
    it('should handle cases with zero negative artifacts', () => {
        require('@/shared/utils/helpers').checkArtifactActiveForTeam.mockReturnValue(
            true,
        );

        const organizationArtifact = {
            teamMethodology: ['Scrum'],
            results: [{ resultType: 'Negative', details: 'Detail' }],
        };
        const payload = [
            {
                teamMethodology: 'Scrum',
                period: '2021-W14',
                organizationAndTeamData: {
                    organizationId: 'org1',
                    teamId: 'team1',
                },
                teamArtifacts: {
                    mostRecentArtifacts: {
                        date: '2021-04-06',
                        artifacts: [{ resultType: 'Positive' }],
                    },
                    previousArtifacts: [
                        {
                            date: '2021-03-30',
                            artifacts: [{ resultType: 'Positive' }],
                        },
                        {
                            date: '2021-03-24',
                            artifacts: [{ resultType: 'Positive' }],
                        },
                    ],
                },
            },
        ];

        const result = flowQualityDeclineArtifact.execute(
            organizationArtifact,
            payload,
        );
        expect(result).not.toBeNull;
    });

    // Test for deterministic results
    it('should return consistent results for the same input', () => {
        const organizationArtifact = {
            teamMethodology: ['Scrum'],
            results: [{ resultType: 'Negative', details: 'Detail' }],
        };
        const payload = [
            {
                teamMethodology: 'Scrum',
                period: '2021-W14',
                organizationAndTeamData: {
                    organizationId: 'org1',
                    teamId: 'team1',
                },
                teamArtifacts: {
                    mostRecentArtifacts: {
                        date: '2021-04-06',
                        artifacts: [{ resultType: 'Negative' }],
                    },
                    previousArtifacts: [
                        {
                            date: '2021-03-30',
                            artifacts: [{ resultType: 'Negative' }],
                        },
                    ],
                },
            },
        ];

        const firstResult = flowQualityDeclineArtifact.execute(
            organizationArtifact,
            payload,
        );
        const secondResult = flowQualityDeclineArtifact.execute(
            organizationArtifact,
            payload,
        );
        expect(firstResult).toEqual(secondResult);
    });

    // Test for handling large volumes of data
    it('should perform well with large volumes of data', () => {
        const largePayload = new Array(1000).fill({
            teamMethodology: 'Scrum',
            period: '2021-W14',
            organizationAndTeamData: {
                organizationId: 'org1',
                teamId: 'team1',
            },
            teamArtifacts: {
                mostRecentArtifacts: {
                    date: '2021-04-06',
                    artifacts: [{ resultType: 'Negative' }],
                },
                previousArtifacts: [
                    {
                        date: '2021-03-30',
                        artifacts: [{ resultType: 'Negative' }],
                    },
                ],
            },
        });

        const result = flowQualityDeclineArtifact.execute(
            { teamMethodology: ['Scrum'] },
            largePayload,
        );
        expect(result).toBeDefined();
        // Additional checks for performance metrics can be included here
    });
});
