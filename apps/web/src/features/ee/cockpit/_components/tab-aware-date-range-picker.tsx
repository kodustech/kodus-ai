"use client";

import { useSearchParams } from "next/navigation";

import { COCKPIT_PARAM } from "../_constants";
import { DateRangePicker } from "./date-range-picker";

export function TabAwareDateRangePicker({
    cookieValue,
}: {
    cookieValue?: string;
}) {
    const tab = useSearchParams().get(COCKPIT_PARAM.tab);
    if (tab === "code-areas") return null;
    return <DateRangePicker cookieValue={cookieValue} />;
}
