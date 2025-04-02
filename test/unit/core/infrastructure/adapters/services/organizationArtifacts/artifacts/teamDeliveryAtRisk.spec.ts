import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { TeamDeliveryAtRiskArtifact } from '@/core/infrastructure/adapters/services/organizationArtifacts/artifacts/teamDeliveryAtRisk.artifact';
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

describe('TeamDeliveryAtRiskArtifact Tests', () => {
    let artifactInstance: TeamDeliveryAtRiskArtifact;
    let mockArtifact: IOrganizationArtifact;
    let mockPayload: IOrganizationArtifacExecutiontPayload[];

    beforeEach(() => {
        artifactInstance = new TeamDeliveryAtRiskArtifact();
        mockArtifact = {
            name: 'TeamDeliveryAtRisk',
            description: '',
            title: 'Sprint with high risk of delay',
            category: 'Delivery monitoring',
            relatedItems: '',
            impactLevel: 'High',
            impactArea: 'Flow quality',
            whyIsImportant:
                'Helps predict delays in the delivery cycle and mitigate impacts on the project schedule.',
            status: true,
            frequenceTypes: ['daily'],
            teamMethodology: ['scrum'],
            results: [
                {
                    resultType: 'Negative',
                    description:
                        'The team has {0}% of items delayed, which will likely compromise deliveries.',
                    howIsIdentified:
                        'We look for items that are delayed relative to the sprint end date.',
                    additionalInfoFormated:
                        'Below are the items that are delayed: \n {0}',
                },
            ],
        };
        mockPayload = [
            {
                organizationAndTeamData: {
                    organizationId: 'org123',
                    teamId: 'team123',
                },
                teamMethodology: 'scrum',
                teamName: 'Development Team', // Added the team name
                frequenceType: 'weekly', // Added the artifact execution frequency
                bugTypeIdentifiers: [], // Added, even if empty, to meet the interface
                workItemTypes: [], // Added, even if empty, to meet the interface
                workItemsWithDeliveryStatus: [
                    {
                        id: '001',
                        key: 'Item001',
                        title: 'Delivery Task',
                        actualStatus: 'Delayed',
                        assignedTo: 'user123',
                        isLate: false,
                        estimatedDeliveryDate: new Date('2024-06-01'),
                        onTrackFlag: 'Off Track',
                    },
                ],
                period: { startDate: '2024-05-21', endDate: '2024-05-26' },
            },
        ];
    });

    test('should return null when artifact is not active', () => {
        require('@/shared/utils/helpers').checkArtifactActiveForTeam.mockReturnValue(
            false,
        );
        const result = artifactInstance.execute(mockArtifact, mockPayload);
        expect(result).toBeNull();
    });

    test('should generate artifact when the proportion of late items is above the threshold', () => {
        mockPayload[0].workItemsWithDeliveryStatus[0].isLate = true; // Make the item late
        require('@/shared/utils/helpers').checkArtifactActiveForTeam.mockReturnValue(
            true,
        );

        const result = artifactInstance.execute(mockArtifact, mockPayload);
        expect(result).toBeNull();
    });

    test('should generate artifact when the proportion of late items is above the threshold', () => {
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
