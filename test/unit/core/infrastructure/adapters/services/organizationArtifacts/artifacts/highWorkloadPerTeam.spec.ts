import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { HighWorkloadPerTeamArtifact } from '@/core/infrastructure/adapters/services/organizationArtifacts/artifacts/highWorkloadPerTeam.artifact';
import {
    organizationFormatResult,
    organizationTeamFormatResult,
} from '@/core/infrastructure/adapters/services/organizationArtifacts/organizationFormatArtifact';

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

describe('HighWorkloadPerTeamArtifact', () => {
    let artifactInstance: HighWorkloadPerTeamArtifact;
    let mockOrganizationArtifact: IOrganizationArtifact;
    let mockPayload: IOrganizationArtifacExecutiontPayload[];

    beforeEach(() => {
        artifactInstance = new HighWorkloadPerTeamArtifact();

        mockOrganizationArtifact = {
            name: 'HighWorkloadPerTeam',
            title: 'High workload for the team',
            category: 'Operational Efficiency',
            relatedItems: '',
            impactLevel: 'Medium',
            impactArea: 'Flow Quality',
            whyIsImportant:
                "Essential to maintain the number of new items in the workflow balanced with the team's delivery capacity.",
            status: true,
            frequenceTypes: ['weekly'],
            teamMethodology: ['scrum', 'kanban'],
            results: [
                {
                    resultType: 'Negative',
                    description:
                        'Possible workload overload identified in the team: {0}',
                    howIsIdentified:
                        "We compare the number of new items entering the team's board during the week with the 75th percentile of throughput from the last month. If the number of new items is greater than or equal to 25% of the historical delivery capacity, the team may be overloaded.",
                    additionalInfoFormated:
                        "This week, the number of new items added to the board ({0}) exceeded the team's historical delivery capacity by {1}%. \n * Throughput (based on the average deliveries from the last month): {2} \n * Items added to the board this week: {0}",
                },
            ],
        };

        mockPayload = [
            {
                organizationAndTeamData: {
                    organizationId: 'Kodus_Organization',
                    teamId: 'team-1',
                },
                bugTypeIdentifiers: [],
                workItemTypes: [],
                frequenceType: 'weekly',
                teamMethodology: 'kanban',
                teamName: 'Team A',
                throughputMetricsHistoric: {
                    differences: [
                        { original: { value: 5 } },
                        { original: { value: 5 } },
                        { original: { value: 5 } },
                        { original: { value: 5 } },
                    ],
                },
                metrics: [
                    {
                        type: METRICS_TYPE.THROUGHPUT,
                        value: { value: 5 },
                    },
                ],
                bugsInWip: [],
                period: { startDate: '2024-05-21', endDate: '2024-05-26' },
                workItemsCreatedInCurrentWeek: [
                    {
                        id: '1',
                        key: 'JR-1',
                        name: 'Work Item',
                        description: {
                            content: [],
                        },
                        changelog: [],
                        workItemCreatedAt: '2024-07-01',
                        columnName: 'In Progress',
                        assignee: {
                            accountId: '',
                            userEmail: '',
                            userName: '',
                        },
                        workItemType: {
                            id: '1',
                            name: 'Story',
                            description: '',
                            subtask: false,
                        },
                        status: {
                            id: '1',
                            name: 'In Progress',
                            statusCategory: {
                                name: '',
                                id: 0,
                            },
                        },
                    },
                    {
                        id: '2',
                        key: 'JR-2',
                        name: 'Work Item',
                        description: {
                            content: [],
                        },
                        changelog: [],
                        workItemCreatedAt: '2024-07-01',
                        columnName: 'In Progress',
                        assignee: {
                            accountId: '',
                            userEmail: '',
                            userName: '',
                        },
                        workItemType: {
                            id: '1',
                            name: 'Story',
                            description: '',
                            subtask: false,
                        },
                        status: {
                            id: '1',
                            name: 'In Progress',
                            statusCategory: {
                                name: '',
                                id: 0,
                            },
                        },
                    },
                    {
                        id: '3',
                        key: 'JR-3',
                        name: 'Work Item',
                        description: {
                            content: [],
                        },
                        changelog: [],
                        workItemCreatedAt: '2024-07-01',
                        columnName: 'In Progress',
                        assignee: {
                            accountId: '',
                            userEmail: '',
                            userName: '',
                        },
                        workItemType: {
                            id: '1',
                            name: 'Story',
                            description: '',
                            subtask: false,
                        },
                        status: {
                            id: '1',
                            name: 'In Progress',
                            statusCategory: {
                                name: '',
                                id: 0,
                            },
                        },
                    },
                    {
                        id: '4',
                        key: 'JR-4',
                        name: 'Work Item',
                        description: {
                            content: [],
                        },
                        changelog: [],
                        workItemCreatedAt: '2024-07-01',
                        columnName: 'In Progress',
                        assignee: {
                            accountId: '',
                            userEmail: '',
                            userName: '',
                        },
                        workItemType: {
                            id: '1',
                            name: 'Story',
                            description: '',
                            subtask: false,
                        },
                        status: {
                            id: '1',
                            name: 'In Progress',
                            statusCategory: {
                                name: '',
                                id: 0,
                            },
                        },
                    },
                    {
                        id: '5',
                        key: 'JR-5',
                        name: 'Work Item',
                        description: {
                            content: [],
                        },
                        changelog: [],
                        workItemCreatedAt: '2024-07-01',
                        columnName: 'In Progress',
                        assignee: {
                            accountId: '',
                            userEmail: '',
                            userName: '',
                        },
                        workItemType: {
                            id: '1',
                            name: 'Story',
                            description: '',
                            subtask: false,
                        },
                        status: {
                            id: '1',
                            name: 'In Progress',
                            statusCategory: {
                                name: '',
                                id: 0,
                            },
                        },
                    },
                    {
                        id: '6',
                        key: 'JR-6',
                        name: 'Work Item',
                        description: {
                            content: [],
                        },
                        changelog: [],
                        workItemCreatedAt: '2024-07-01',
                        columnName: 'In Progress',
                        assignee: {
                            accountId: '',
                            userEmail: '',
                            userName: '',
                        },
                        workItemType: {
                            id: '1',
                            name: 'Story',
                            description: '',
                            subtask: false,
                        },
                        status: {
                            id: '1',
                            name: 'In Progress',
                            statusCategory: {
                                name: '',
                                id: 0,
                            },
                        },
                    },
                    {
                        id: '7',
                        key: 'JR-7',
                        name: 'Work Item',
                        description: {
                            content: [],
                        },
                        changelog: [],
                        workItemCreatedAt: '2024-07-01',
                        columnName: 'In Progress',
                        assignee: {
                            accountId: '',
                            userEmail: '',
                            userName: '',
                        },
                        workItemType: {
                            id: '1',
                            name: 'Story',
                            description: '',
                            subtask: false,
                        },
                        status: {
                            id: '1',
                            name: 'In Progress',
                            statusCategory: {
                                name: '',
                                id: 0,
                            },
                        },
                    },
                    {
                        id: '8',
                        key: 'JR-8',
                        name: 'Work Item',
                        description: {
                            content: [],
                        },
                        changelog: [],
                        workItemCreatedAt: '2024-07-01',
                        columnName: 'In Progress',
                        assignee: {
                            accountId: '',
                            userEmail: '',
                            userName: '',
                        },
                        workItemType: {
                            id: '1',
                            name: 'Story',
                            description: '',
                            subtask: false,
                        },
                        status: {
                            id: '1',
                            name: 'In Progress',
                            statusCategory: {
                                name: '',
                                id: 0,
                            },
                        },
                    },
                    {
                        id: '9',
                        key: 'JR-9',
                        name: 'Work Item',
                        description: {
                            content: [],
                        },
                        changelog: [],
                        workItemCreatedAt: '2024-07-01',
                        columnName: 'In Progress',
                        assignee: {
                            accountId: '',
                            userEmail: '',
                            userName: '',
                        },
                        workItemType: {
                            id: '1',
                            name: 'Story',
                            description: '',
                            subtask: false,
                        },
                        status: {
                            id: '1',
                            name: 'In Progress',
                            statusCategory: {
                                name: '',
                                id: 0,
                            },
                        },
                    },
                    {
                        id: '10',
                        key: 'JR-10',
                        name: 'Work Item',
                        description: {
                            content: [],
                        },
                        changelog: [],
                        workItemCreatedAt: '2024-07-01',
                        columnName: 'In Progress',
                        assignee: {
                            accountId: '',
                            userEmail: '',
                            userName: '',
                        },
                        workItemType: {
                            id: '1',
                            name: 'Story',
                            description: '',
                            subtask: false,
                        },
                        status: {
                            id: '1',
                            name: 'In Progress',
                            statusCategory: {
                                name: '',
                                id: 0,
                            },
                        },
                    },
                ],
            },
        ];
    });

    afterEach(() => {
        jest.restoreAllMocks();
        (organizationTeamFormatResult as jest.Mock).mockClear();
    });

    test('execute should return null when no team artifacts meet criteria', () => {
        require('@/shared/utils/helpers').checkArtifactActiveForTeam.mockReturnValue(
            false,
        );

        const result = artifactInstance.execute(
            mockOrganizationArtifact,
            mockPayload,
        );

        expect(result).toBeNull();
        expect(
            require('@/core/infrastructure/adapters/services/organizationArtifacts/organizationFormatArtifact')
                .organizationFormatResult,
        ).not.toHaveBeenCalled();
    });

    test('execute should correctly process and return artifacts when conditions are met', () => {
        require('@/shared/utils/helpers').checkArtifactActiveForTeam.mockReturnValue(
            true,
        );

        (organizationTeamFormatResult as jest.Mock).mockImplementationOnce(
            jest.requireActual(
                '@/core/infrastructure/adapters/services/organizationArtifacts/organizationFormatArtifact',
            ).organizationTeamFormatResult,
        );

        (organizationFormatResult as jest.Mock).mockImplementationOnce(
            jest.requireActual(
                '@/core/infrastructure/adapters/services/organizationArtifacts/organizationFormatArtifact',
            ).organizationFormatResult,
        );

        const result = artifactInstance.execute(
            mockOrganizationArtifact,
            mockPayload,
        );

        expect(result).not.toBeNull();
        expect(result.teamsArtifact[0].criticality).toBe(100);
        expect(organizationTeamFormatResult).toHaveBeenCalled();
    });

    describe('calculateAverage', () => {
        it('should calculate the average of differences', () => {
            // Mock input data
            const data = {
                differences: [
                    { original: { value: 5 } },
                    { original: { value: 5 } },
                    { original: { value: 5 } },
                    { original: { value: 5 } },
                ],
            };

            // Call the calculateAverage method
            const result = artifactInstance['calculateAverage'](data);

            // Assert the result
            expect(result).toBe(5);
        });
    });
});
