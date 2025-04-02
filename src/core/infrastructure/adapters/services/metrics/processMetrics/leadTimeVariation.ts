import { DEVIATION_LEVEL } from '@/core/domain/metrics/enums/metricDeviation.enum';
import { StandardDeviationCalculator } from '@/shared/utils/standardDeviationCalculator';

export class LeadTimeVariation {
    constructor() {}

    private calculateQuartiles(values: number[]) {
        const sorted = values.slice().sort((a, b) => a - b);
        const q1 = sorted[Math.floor(sorted.length / 4)];
        const q2 = sorted[Math.floor(sorted.length / 2)];
        const q3 = sorted[Math.floor((sorted.length * 3) / 4)];
        return { q1, q2, q3 };
    }

    private filterOutliers(values: number[]) {
        const { q1, q3 } = this.calculateQuartiles(values);
        const iqr = q3 - q1;
        const lowerBound = q1 - 1.5 * iqr;
        const upperBound = q3 + 1.5 * iqr;
        return values.filter(
            (value) => value >= lowerBound && value <= upperBound,
        );
    }

    private deviationClassification(standardDeviation) {
        const thresholds: {
            low: number;
            medium: number;
            high: number;
        } = {
            low: 20,
            medium: 50,
            high: 100,
        };

        if (standardDeviation < thresholds.low) {
            return DEVIATION_LEVEL.LOW;
        } else if (standardDeviation < thresholds.medium) {
            return DEVIATION_LEVEL.MEDIUM;
        } else if (standardDeviation < thresholds.high) {
            return DEVIATION_LEVEL.HIGH;
        } else {
            return DEVIATION_LEVEL.SEVERE;
        }
    }

    calculateStandardDeviationOfVariations(leadTimes: number[]) {
        const filteredLeadTimes = this.filterOutliers(leadTimes);
        const stdDevCalculator = new StandardDeviationCalculator(
            filteredLeadTimes,
        );
        const deviation = stdDevCalculator.calculate();

        return {
            value:
                isNaN(deviation) || deviation === null
                    ? 0
                    : Number(deviation.toFixed(0)),
            level: this.deviationClassification(deviation),
        };
    }
}
