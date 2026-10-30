"use server";

import { updateTag } from "next/cache";
import { cookies } from "next/headers";

export const setCockpitDateRangeCookie = async (range: {
    from: string | undefined;
    to: string | undefined;
}) => {
    const cookieStore = await cookies();

    cookieStore.set({
        name: "cockpit-selected-date-range",
        value: JSON.stringify(range),
    });

    // Read-your-writes: the cookie above drives the analytics fetches, so the
    // next render has to see the new range, not a stale-while-revalidate copy.
    updateTag("cockpit-date-range-dependent");
};
