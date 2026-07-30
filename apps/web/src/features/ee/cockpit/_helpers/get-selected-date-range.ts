import { cookies } from "next/headers";
import { formatDate, subDays } from "date-fns";
import type { CookieName } from "src/core/utils/cookie";
import { getCurrentSearchParamsOnServerComponents } from "src/core/utils/headers";

import { COCKPIT_PARAM } from "../_constants";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isValidISODate = (value: string | null): value is string =>
    !!value && ISO_DATE.test(value) && !isNaN(new Date(value).getTime());

export const getSelectedDateRange = async (): Promise<{
    startDate: string;
    endDate: string;
}> => {
    const [cookieStore, searchParams] = await Promise.all([
        cookies(),
        getCurrentSearchParamsOnServerComponents(),
    ]);

    // URL wins: a shared link reproduces the exact range it encodes,
    // regardless of the recipient's cookie.
    const urlStart = searchParams.get(COCKPIT_PARAM.start);
    const urlEnd = searchParams.get(COCKPIT_PARAM.end);
    if (isValidISODate(urlStart) && isValidISODate(urlEnd)) {
        return { startDate: urlStart, endDate: urlEnd };
    }

    const selectedDateRangeFromCookie = cookieStore.get(
        "cockpit-selected-date-range" satisfies CookieName,
    )?.value;

    // Default window: last 15 days — kept in sync with the DateRangePicker's
    // default preset so the trigger label and the fetched data agree.
    const endDate = new Date();
    const startDate = subDays(endDate, 15);

    let parsedDateRangeFromCookie: {
        startDate: Date | string;
        endDate: Date | string;
    } = { startDate, endDate };

    if (selectedDateRangeFromCookie) {
        try {
            const dateRange = JSON.parse(selectedDateRangeFromCookie) as {
                from: string;
                to: string;
            };
            const fromDate = new Date(dateRange.from);
            const toDate = new Date(dateRange.to);

            if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime())) {
                parsedDateRangeFromCookie = {
                    startDate: dateRange.from,
                    endDate: dateRange.to,
                };
            }
        } catch (error) {
            console.error("Invalid date range cookie format:", error);
            // Keep default date range
        }
    }

    return {
        startDate: formatDate(
            parsedDateRangeFromCookie.startDate,
            "yyyy-MM-dd",
        ),
        endDate: formatDate(parsedDateRangeFromCookie.endDate, "yyyy-MM-dd"),
    };
};
