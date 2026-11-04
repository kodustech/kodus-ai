"use client";

import { useQueryState } from "nuqs";

import { COCKPIT_PARAM } from "../_constants";
import { DateRangePicker } from "./date-range-picker";

export function TabAwareDateRangePicker({
    cookieValue,
}: {
    cookieValue?: string;
}) {
    const [tab] = useQueryState(COCKPIT_PARAM.tab);
    if (tab === "code-areas") return null;
    return <DateRangePicker cookieValue={cookieValue} />;
}
