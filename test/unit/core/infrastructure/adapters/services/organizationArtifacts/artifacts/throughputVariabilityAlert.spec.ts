import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { ThroughputVariabilityAlertArtifact } from '@/core/infrastructure/adapters/services/organizationArtifacts/artifacts/throughputVariabilityAlert.artifact';
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

describe('ThroughputVariabilityAlertArtifact Tests', () => {
    let artifactInstance: ThroughputVariabilityAlertArtifact;
    let mockArtifact: IOrganizationArtifact;
    let mockPayload: IOrganizationArtifacExecutiontPayload[];

    beforeEach(() => {
        artifactInstance = new ThroughputVariabilityAlertArtifact();
        mockArtifact = {
            name: 'ThroughputVariabilityAlert',
            title: 'High variability in team throughput',
            description: 'Monitors significant variability in team throughput',
            category: 'Predictability',
            relatedItems: '',
            impactLevel: 'Medium',
            impactArea: 'Flow quality',
            whyIsImportant:
                'Essential to maintain consistency and predictability of deliveries.',
            status: true,
            frequenceTypes: ['weekly'],
            teamMethodology: ['scrum', 'kanban'],
            results: [
                {
                    resultType: 'Negative',
                    description:
                        'The team showed a throughput variation greater than {0}% in recent weeks.',
                    howIsIdentified: 'We analyze the throughput of each team.',
                    additionalInfoFormated:
                        "Below is the team's throughput history: \n {0}",
                },
            ],
        };

        mockPayload = [
            {
                organizationAndTeamData: {
                    organizationId: 'org123',
                    teamId: 'team123',
                },
                teamMethodology: 'kanban',
                teamName: 'Development Team', // Added missing 'teamName'
                frequenceType: 'weekly', // Added missing 'frequenceType'
                bugTypeIdentifiers: [], // Added empty array for 'bugTypeIdentifiers'
                workItemTypes: [], // Added empty array for 'workItemTypes'
                throughputMetricsHistoric: {
                    differences: [
                        {
                            date: '2024-05-21',
                            value: 5,
                            original: { value: 5 },
                        },
                        {
                            date: '2024-05-16',
                            value: 6,
                            original: { value: 6 },
                        },
                        {
                            date: '2024-05-10',
                            value: 10,
                            original: { value: 10 },
                        },
                    ],
                    original: { date: '2024-05-26', value: 4 },
                },
                period: { startDate: '2024-05-21', endDate: '2024-05-26' },
            },
        ];
    });

    test('should return null when throughput history is insufficient', () => {
        mockPayload[0].throughputMetricsHistoric.differences = []; // Insufficient history
        const result = artifactInstance.execute(mockArtifact, mockPayload);
        expect(result).toBeNull();
    });

    test('should generate artifact when throughput variability is significant', () => {
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

        const result = artifactInstance.execute(mockArtifact, mockPayload);
        expect(result).not.toBeNull();
    });
});
