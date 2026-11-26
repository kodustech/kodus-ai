import { differenceInDays, format, subDays } from "date-fns";

import type { OrganizationLicense } from "../../_services/billing/types";

export const USAGE_LOOKBACK_DAYS = 30;

/**
 * The usage window the token projection reads: from the day a trial started,
 * or the last 30 days for anything else.
 *
 * Billing reports the trial's own start, so the window holds for any trial
 * length and for trials extended by hand. A trial without a usable trialStart
 * (billing builds that predate it, rows edited by SQL) falls back to the
 * default lookback instead of crashing the choose-plan page on Invalid Date.
 */
export function getUsageDateRange(
    license: OrganizationLicense | null,
    now: Date = new Date(),
) {
    if (
        license?.valid &&
        license.subscriptionStatus === "trial" &&
        license.trialStart
    ) {
        const trialStartDate = new Date(license.trialStart);
        if (!isNaN(trialStartDate.getTime()) && trialStartDate <= now) {
            return {
                startDate: format(trialStartDate, "yyyy-MM-dd"),
                endDate: format(now, "yyyy-MM-dd"),
                daysUsed: Math.max(1, differenceInDays(now, trialStartDate)),
            };
        }
    }

    return {
        startDate: format(subDays(now, USAGE_LOOKBACK_DAYS), "yyyy-MM-dd"),
        endDate: format(now, "yyyy-MM-dd"),
        daysUsed: USAGE_LOOKBACK_DAYS,
    };
}
