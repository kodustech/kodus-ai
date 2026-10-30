"use client";

import { useQueryState } from "nuqs";

import { COCKPIT_PARAM } from "../_constants";
import { RepositoryPicker } from "./repository-picker";

export function TabAwareRepositoryPicker({
    cookieValue,
    teamId,
}: {
    cookieValue?: string;
    teamId: string;
}) {
    const [tab] = useQueryState(COCKPIT_PARAM.tab);
    if (tab === "code-areas") return null;
    return <RepositoryPicker cookieValue={cookieValue} teamId={teamId} />;
}
