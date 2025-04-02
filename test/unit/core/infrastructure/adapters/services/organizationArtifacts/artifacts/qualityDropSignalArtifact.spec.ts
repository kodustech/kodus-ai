import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { QualityDropSignalArtifact } from '@/core/infrastructure/adapters/services/organizationArtifacts/artifacts/qualityDropSignal.artifact';
import {
    organizationFormatResult,
    organizationTeamFormatResult,
} from '@/core/infrastructure/adapters/services/organizationArtifacts/organizationFormatArtifact';

// Mocks for external modules and functions
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

describe('qualityDropSignalArtifact execute function tests', () => {
    let artifactInstance: QualityDropSignalArtifact;
    let mockOrganizationArtifact: IOrganizationArtifact;
    let mockPayload: IOrganizationArtifacExecutiontPayload[];

    beforeEach(() => {
        artifactInstance = new QualityDropSignalArtifact();

        mockOrganizationArtifact = {
            name: 'QualityDropSignal',
            description: '',
            title: 'Significant increase in bugs in deliveries',
            category: 'Delivery Quality',
            relatedItems: '',
            impactLevel: 'High',
            impactArea: 'Flow Quality',
            whyIsImportant:
                'Ensures that quality is not compromised by deadline pressure and workload.',
            status: true,
            frequenceTypes: ['weekly'],
            teamMethodology: ['scrum', 'kanban'],
            results: [
                {
                    resultType: 'Negative',
                    description:
                        'The team is spending {0}% of the total effort on bug fixing, which may impact the quality of deliveries.',
                    howIsIdentified: 'We look at the bug ratio of each team.',
                    additionalInfoFormated:
                        'Below is the list of bugs the team is working on: \n {0}',
                },
            ],
        };

        mockPayload = [
            {
                organizationAndTeamData: {
                    organizationId: 'org123',
                    teamId: 'team123',
                },
                bugTypeIdentifiers: [],
                workItemTypes: [],
                frequenceType: 'weekly',
                teamMethodology: 'kanban',
                teamName: 'Development Team',
                metrics: [
                    {
                        type: METRICS_TYPE.BUG_RATIO,
                        value: { value: 0.5 },
                    },
                ],
                bugsInWip: [{ key: 'bug123', name: 'Critical Bug' }],
                period: { startDate: '2024-05-21', endDate: '2024-05-26' },
            },
        ];
    });

    afterEach(() => {
        // Restaura o método original após cada teste
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

    test('should handle undefined bugRatio gracefully', () => {
        // Remover ou invalidar bugRatio no payload
        delete mockPayload[0].metrics;
        expect(() =>
            artifactInstance.execute(mockOrganizationArtifact, mockPayload),
        ).not.toThrow();
    });

    test('generateTeamArtifact should return undefined if bug ratio is below the limit', () => {
        const result = artifactInstance['generateTeamArtifact'](
            'Development Team',
            0.3, // Below the recommendation limit
            mockOrganizationArtifact,
            mockPayload[0].organizationAndTeamData,
            mockPayload[0].bugsInWip,
        );

        expect(result).toBeUndefined();
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

        mockPayload[0].metrics = [
            { type: METRICS_TYPE.BUG_RATIO, value: { value: 0.7 } },
        ];

        const result = artifactInstance.execute(
            mockOrganizationArtifact,
            mockPayload,
        );

        expect(result).not.toBeNull();
        expect(organizationTeamFormatResult).toHaveBeenCalled();
    });
});
