"use client";

import { useMemo, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Card } from "@components/ui/card";
import { Link } from "@components/ui/link";
import { Skeleton } from "@components/ui/skeleton";
import { useIntentCockpit } from "@services/business-logic/hooks";
import type { RequirementTopic } from "@services/business-logic/types";
import { formatDate, subDays } from "date-fns";
import { useAllTeams } from "src/core/providers/all-teams-context";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { COCKPIT_PARAM } from "../_constants";

const TOPICS: Record<RequirementTopic, string> = {
    empty_and_error_states: "Empty and error states",
    permissions: "Permission checks",
    default_values: "Default values",
    validation: "Input validation",
    audit_and_logging: "Audit log entries",
    data_and_persistence: "Saving and loading data",
    notifications: "Notifications",
    ui_and_copy: "Screens and copy",
    integrations: "Integrations",
    performance: "Performance",
    other: "Other",
};

const percent = (value?: number) =>
    value === undefined ? "—" : `${Math.round(value * 100)}%`;

const rangeFrom = (
    searchParams: URLSearchParams,
    cookieValue: string | undefined,
) => {
    const from = searchParams.get(COCKPIT_PARAM.start);
    const to = searchParams.get(COCKPIT_PARAM.end);
    if (from && to) return { startDate: from, endDate: to };
    try {
        const parsed = cookieValue ? JSON.parse(cookieValue) : undefined;
        if (parsed?.from && parsed?.to) {
            return { startDate: parsed.from, endDate: parsed.to };
        }
    } catch {
        // fall through to the default window
    }
    const today = new Date();
    return {
        startDate: formatDate(subDays(today, 30), "yyyy-MM-dd"),
        endDate: formatDate(today, "yyyy-MM-dd"),
    };
};

const Metric = ({
    label,
    value,
    hint,
}: {
    label: string;
    value: string;
    hint: ReactNode;
}) => (
    <Card color="lv1" className="flex flex-col gap-1 px-5 py-4">
        <span className="text-text-secondary text-xs">{label}</span>
        <span className="text-text-primary text-2xl font-semibold">
            {value}
        </span>
        <span className="text-text-tertiary text-xs">{hint}</span>
    </Card>
);

/**
 * Delivered as asked: pull requests checked against their task, by who
 * wrote the code and by team (UC-42). Read from Business Logic runs.
 */
export const IntentTab = ({ cookieValue }: { cookieValue?: string }) => {
    const searchParams = useSearchParams();
    const { teamId } = useSelectedTeamId();
    const range = useMemo(
        () => rangeFrom(searchParams, cookieValue),
        [searchParams, cookieValue],
    );
    const { data, isLoading, isError } = useIntentCockpit({ ...range, teamId });
    const { teams } = useAllTeams();
    const teamName = (id: string) =>
        teams?.find((t) => t.uuid === id)?.name ?? "Team";

    if (isLoading) {
        return <Skeleton className="h-64 w-full rounded-xl" />;
    }
    if (isError || !data) {
        return (
            <Card color="lv1" className="px-5 py-4 text-sm">
                Couldn&apos;t load the intent view. Try again in a moment.
            </Card>
        );
    }
    if (!data.pullRequests) {
        return (
            <Card color="lv1" className="flex flex-col gap-2 px-5 py-4 text-sm">
                <span className="text-text-primary font-medium">
                    No pull request was checked against its task in this period.
                </span>
                <span className="text-text-secondary">
                    Turn on Business Logic and connect a task tracker to see
                    whether pull requests deliver what their task asked.{" "}
                    <Link href="/settings/code-review/global/business-logic">
                        Set up Business Logic
                    </Link>
                </span>
            </Card>
        );
    }

    const delta =
        data.metRate !== undefined && data.previousMetRate !== undefined
            ? Math.round((data.metRate - data.previousMetRate) * 100)
            : undefined;

    return (
        <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <Metric
                    label="Met their task"
                    value={percent(data.metRate)}
                    hint={
                        delta === undefined
                            ? `${data.pullRequests} PRs checked`
                            : `${delta >= 0 ? "+" : ""}${delta} pts vs the previous period`
                    }
                />
                <Metric
                    label="Changes not in the task"
                    value={percent(data.notInTaskRate)}
                    hint="of PRs had at least one"
                />
                <Metric
                    label="Findings accepted"
                    value={percent(data.agreedRate)}
                    hint="how often devs agreed with Kody"
                />
                <Metric
                    label="Without a readable task"
                    value={percent(data.withoutTaskRate)}
                    hint={
                        <Link href="/settings/code-review/global/business-logic">
                            see why
                        </Link>
                    }
                />
            </div>

            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
                <Card color="lv1" className="flex flex-col gap-3 px-5 py-4">
                    <span className="text-text-primary text-sm font-medium">
                        By who wrote the code
                    </span>
                    <ul className="flex flex-col gap-2">
                        {data.byAuthor.map((row) => (
                            <li
                                key={row.author}
                                className="flex items-center gap-3 text-sm">
                                <span className="text-text-secondary w-36 shrink-0 truncate">
                                    {row.author}
                                </span>
                                <span className="bg-card-lv3 relative h-2 flex-1 overflow-hidden rounded-full">
                                    <span
                                        className="bg-primary-light absolute inset-y-0 left-0 rounded-full"
                                        style={{
                                            width: `${Math.round(row.metRate * 100)}%`,
                                        }}
                                    />
                                </span>
                                <span className="text-text-primary w-12 text-right tabular-nums">
                                    {percent(row.metRate)}
                                </span>
                            </li>
                        ))}
                    </ul>
                    <span className="text-text-tertiary text-xs">
                        Share of PRs that met their task. Who wrote it comes
                        from the commit author and Co-Authored-By trailers
                        {data.unidentifiedRate
                            ? `; ${percent(data.unidentifiedRate)} of PRs carry neither`
                            : ""}
                        .
                    </span>
                </Card>

                <Card color="lv1" className="flex flex-col gap-3 px-5 py-4">
                    <span className="text-text-primary text-sm font-medium">
                        Most often missed
                    </span>
                    {data.mostMissed.length ? (
                        <ul className="flex flex-col gap-2 text-sm">
                            {data.mostMissed.map((row) => (
                                <li
                                    key={row.topic}
                                    className="flex justify-between gap-4">
                                    <span className="text-text-primary">
                                        {TOPICS[row.topic]}
                                    </span>
                                    <span className="text-text-secondary tabular-nums">
                                        {row.pullRequests} PRs
                                    </span>
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <span className="text-text-secondary text-sm">
                            Nothing missed more than once.
                        </span>
                    )}
                    <span className="text-text-tertiary text-xs">
                        Good candidates for a team Kody Rule or a ticket
                        template.
                    </span>
                </Card>
            </div>

            {data.byTeam.length > 1 && (
                <Card color="lv1" className="overflow-x-auto px-5 py-4">
                    <table className="w-full min-w-[480px] text-sm">
                        <thead>
                            <tr className="text-text-secondary text-left text-xs">
                                <th className="py-2 font-medium">Team</th>
                                <th className="py-2 text-right font-medium">
                                    PRs
                                </th>
                                <th className="py-2 text-right font-medium">
                                    Met task
                                </th>
                                <th className="py-2 text-right font-medium">
                                    Not in task
                                </th>
                                <th className="py-2 text-right font-medium">
                                    Without task
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.byTeam.map((row) => (
                                <tr
                                    key={row.teamId}
                                    className="border-card-lv3/60 border-t">
                                    <td className="text-text-primary py-2">
                                        {teamName(row.teamId)}
                                    </td>
                                    <td className="py-2 text-right tabular-nums">
                                        {row.pullRequests}
                                    </td>
                                    <td className="py-2 text-right tabular-nums">
                                        {percent(row.metRate)}
                                    </td>
                                    <td className="py-2 text-right tabular-nums">
                                        {percent(row.notInTaskRate)}
                                    </td>
                                    <td className="py-2 text-right tabular-nums">
                                        {percent(row.withoutTaskRate)}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </Card>
            )}
        </div>
    );
};
