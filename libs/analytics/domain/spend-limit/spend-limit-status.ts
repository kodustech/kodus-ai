import {
    SPEND_LIMIT_THRESHOLDS,
    SpendLimitStatus,
} from './spend-limit.types';

/**
 * Pure evaluation of month-to-date spend against a monthly limit. No I/O —
 * this is the shared decision function for the alert cron and a future
 * blocking gate, so it must stay side-effect free and deterministic.
 *
 * A non-positive (or non-finite) limit means "no usable limit configured":
 * nothing is crossed and nothing is over. Negative/non-finite spend clamps
 * to zero rather than producing nonsensical percentages.
 */
export function buildSpendLimitStatus(
    spentUsd: number,
    limitUsd: number,
    thresholds: readonly number[] = SPEND_LIMIT_THRESHOLDS,
): SpendLimitStatus {
    const safeSpent =
        Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0;

    if (!Number.isFinite(limitUsd) || limitUsd <= 0) {
        return {
            spentUsd: safeSpent,
            limitUsd: 0,
            pct: 0,
            isOverLimit: false,
            crossedThresholds: [],
        };
    }

    const pct = (safeSpent / limitUsd) * 100;
    const crossedThresholds = [...thresholds]
        .sort((a, b) => a - b)
        .filter((threshold) => pct >= threshold);

    return {
        spentUsd: safeSpent,
        limitUsd,
        pct,
        isOverLimit: pct >= 100,
        crossedThresholds,
    };
}
