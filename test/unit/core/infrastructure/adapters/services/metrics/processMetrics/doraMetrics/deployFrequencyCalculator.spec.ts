import { DeployFrequency } from '@/core/domain/platformIntegrations/types/codeManagement/deployFrequency.type';
import { DeployFrequencyCalculator } from '@/core/infrastructure/adapters/services/metrics/processMetrics/doraMetrics/deployFrequency';

jest.mock('@/shared/utils/transforms/date', () => ({
    getDayForFilter: jest.fn().mockReturnValue({
        today: new Date('2023-05-31T23:59:59Z').toISOString(),
        dateAfterDaysInformed: new Date('2023-05-24T00:00:00Z').toISOString(),
    }),
    getDaysBetweenDates: jest.fn().mockReturnValue(31),
    getWeeksBetweenDates: jest.fn().mockReturnValue(4.43), // Approximate number of weeks in a month
}));

describe('DeployFrequencyCalculator', () => {
    let deployFrequencyData: DeployFrequency[];

    beforeEach(() => {
        deployFrequencyData = [
            {
                id: 1,
                created_at: '2023-05-10T12:00:00Z',
                repository: 'repo1',
            },
            {
                id: 2,
                created_at: '2023-05-20T12:00:00Z',
                repository: 'repo2',
            },
        ];
    });

    it('should calculate deploy frequency correctly with multiple deploys', () => {
        const analysisPeriod = {
            startTime: new Date('2023-05-01T00:00:00Z'),
            endTime: new Date('2023-05-31T23:59:59Z'),
        };
        const calculator = new DeployFrequencyCalculator();
        calculator.setConfiguration({ deployFrequencyData, analysisPeriod });

        const result = calculator.calculateDeployFrequency();
        expect(result.deploymentsTotal).toBe(2);
        expect(result.dailyFrequency).toBe(0.06);
        expect(result.weeklyFrequency).toBe(0.45);
    });

    it('should calculate deploy frequency correctly with no deploys', () => {
        deployFrequencyData = [];
        const analysisPeriod = {
            startTime: new Date('2023-05-01T00:00:00Z'),
            endTime: new Date('2023-05-31T23:59:59Z'),
        };
        const calculator = new DeployFrequencyCalculator();
        calculator.setConfiguration({ deployFrequencyData, analysisPeriod });

        const result = calculator.calculateDeployFrequency();
        expect(result.deploymentsTotal).toBe(0);
        expect(result.dailyFrequency).toBe(0);
        expect(result.weeklyFrequency).toBe(0);
    });

    it('should calculate deploys in the last week correctly', () => {
        deployFrequencyData.push({
            id: 3,
            created_at: '2023-05-25T12:00:00Z',
            repository: 'repo3',
        });
        const analysisPeriod = {
            startTime: new Date('2023-05-01T00:00:00Z'),
            endTime: new Date('2023-05-31T23:59:59Z'),
        };
        const calculator = new DeployFrequencyCalculator();
        calculator.setConfiguration({ deployFrequencyData, analysisPeriod });
        const result = calculator.calculateDeployFrequency();
        expect(result.deploymentsLastWeek).toBe(1);
    });
});
