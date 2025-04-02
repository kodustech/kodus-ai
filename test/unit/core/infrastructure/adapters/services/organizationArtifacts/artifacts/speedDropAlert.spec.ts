import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { SpeedDropAlertArtifact } from '@/core/infrastructure/adapters/services/organizationArtifacts/artifacts/speedDropAlert.artifact';

jest.mock('@/shared/utils/helpers', () => ({
    checkArtifactActiveForTeam: jest.fn(),
}));

describe('SpeedDropAlertArtifact Tests', () => {
    let artifactInstance: SpeedDropAlertArtifact;
    let mockArtifact: IOrganizationArtifact;
    let mockPayload: IOrganizationArtifacExecutiontPayload[];

    beforeEach(() => {
        artifactInstance = new SpeedDropAlertArtifact();
        mockArtifact = {
            name: 'SpeedDropAlert',
            description: '',
            title: 'Team Productivity Drop',
            category: 'Delivery Monitoring',
            impactLevel: 'Medium',
            impactArea: 'Flow Quality',
            relatedItems: '',
            whyIsImportant:
                'Allows quick interventions to resolve issues that are slowing down the team.',
            status: true,
            frequenceTypes: ['weekly'],
            teamMethodology: ['kanban'],
            results: [
                {
                    resultType: 'Negative',
                    description:
                        'The team experienced a productivity drop in {0}% of the items worked on.',
                    howIsIdentified: 'We look at the lead time of each team.',
                    additionalInfoFormated:
                        'Below is the list of items that are delayed: \n {0}',
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
                teamName: 'Development Team',
                bugTypeIdentifiers: [], // Add this line if necessary
                workItemTypes: [], // Add this line if necessary
                frequenceType: 'weekly', // Add this line if necessary
                workItemsWithDeliveryStatus: [
                    {
                        id: '001',
                        key: 'item001',
                        title: 'Task Item',
                        actualStatus: 'In Progress',
                        assignedTo: 'user123',
                        isLate: true,
                        onTrackFlag: 'On Track',
                        leadTimeToEnd: 5,
                        leadTimeUsed: 3,
                        percentageLeadTimeAlreadyUsed: 60,
                        estimatedDeliveryDate: new Date('2024-06-01'), // Ensure this field is present
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

    test('should process and return formatted result when conditions are met and items are late', () => {
        require('@/shared/utils/helpers').checkArtifactActiveForTeam.mockReturnValue(
            true,
        );
        const result = artifactInstance.execute(mockArtifact, mockPayload);
        expect(result).not.toBeNull();
        expect(result.teamsArtifact.length).toBeGreaterThan(0);
    });

    test('should handle no late items without generating an artifact', () => {
        // Assumir que não há itens atrasados
        mockPayload[0].workItemsWithDeliveryStatus =
            mockPayload[0].workItemsWithDeliveryStatus.map((item) => ({
                ...item,
                isLate: false,
            }));
        const result = artifactInstance.execute(mockArtifact, mockPayload);
        expect(result).toBeNull();
    });
});
