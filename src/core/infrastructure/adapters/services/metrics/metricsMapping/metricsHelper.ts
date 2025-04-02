import { MetricsVariationStatus } from '@/shared/domain/enums/metrics-variation-status.enum';
import * as moment from 'moment-timezone';

class MetricsHelper {
    public calculateVariation(currentValue, previousValue, isInverted) {
        let variation;
        if (currentValue > 0 && previousValue <= 0) {
            variation = 100;
        } else if (previousValue > 0 && currentValue <= 0) {
            variation = -100;
        } else if (currentValue === 0 && previousValue === 0) {
            variation = 0;
        } else {
            variation = ((currentValue - previousValue) / previousValue) * 100;
        }
        const type =
            variation === 0
                ? MetricsVariationStatus.NEUTRAL
                : variation < 0
                  ? isInverted
                      ? MetricsVariationStatus.IMPROVES
                      : MetricsVariationStatus.WORSENS
                  : isInverted
                    ? MetricsVariationStatus.WORSENS
                    : MetricsVariationStatus.IMPROVES;

        return {
            variation: `${Math.abs(variation).toFixed(2)}%`,
            type: type,
        };
    }

    public calculateInitialDate(finalDate, days) {
        const date = moment(finalDate).subtract(days, 'days');
        return moment(date).format('DD/MM/YYYY');
    }
}

export { MetricsHelper };
