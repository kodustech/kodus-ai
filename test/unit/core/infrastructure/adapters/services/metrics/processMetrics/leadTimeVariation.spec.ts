import { DEVIATION_LEVEL } from '@/core/domain/metrics/enums/metricDeviation.enum';
import { LeadTimeVariation } from '@/core/infrastructure/adapters/services/metrics/processMetrics/leadTimeVariation';

describe('LeadTimeVariation', () => {
    let leadTimeVariation: LeadTimeVariation;

    beforeEach(() => {
        leadTimeVariation = new LeadTimeVariation();
    });

    describe('calculateQuartiles', () => {
        it('should correctly calculate quartis for an even set of numbers', () => {
            const values = [1, 2, 3, 4, 5, 6, 7, 8];
            expect(leadTimeVariation['calculateQuartiles'](values)).toEqual({
                q1: 3,
                q2: 5,
                q3: 7,
            });
        });

        it('should handle an empty array by returning null or some default', () => {
            expect(leadTimeVariation['calculateQuartiles']([])).toEqual({
                q1: undefined,
                q2: undefined,
                q3: undefined,
            });
        });
    });

    describe('filterOutliers', () => {
        it('should filter outliers from a data set', () => {
            const values = [10, 12, 23, 23, 16, 23, 21, 100];
            expect(leadTimeVariation['filterOutliers'](values)).toEqual([
                10, 12, 23, 23, 16, 23, 21,
            ]);
        });
    });
    describe('calculateStandardDeviationOfVariations', () => {
        it('should calculate the standard deviation of lead time variations, excluding outliers', () => {
            const leadTimes = [5, 10, 15, 20, 100];
            const result =
                leadTimeVariation.calculateStandardDeviationOfVariations(
                    leadTimes,
                );
            expect(result.value).toBeCloseTo(6, 2);
            expect(result.level).toEqual(DEVIATION_LEVEL.LOW);
        });
    });
});
