import { CardContent, CardFooter } from "@components/ui/card";
import { DashedLine } from "@components/ui/dashed-line";
import { Separator } from "@components/ui/separator";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { formatISO, subWeeks } from "date-fns";
import { getLeadTimeForChangeAnalytics } from "src/features/ee/cockpit/_services/analytics/productivity/fetch";
import { getPercentageDiff } from "src/features/ee/cockpit/_services/analytics/utils";

import { InsightsBadge } from "../_components/insights-badge";
import { PercentageDiff } from "../_components/percentage-diff";
import { extractApiData } from "../_helpers/api-data-extractor";
import { PRCycleTimeAnalyticsHeader } from "./_components/header";
import NoData from "./_components/no-data";

const comparisonParameters = {
    "elite": {
        label: "<48 hours",
        compareFn: (hours: number) => hours < 48,
    },
    "high": {
        label: "48-84 hours",
        compareFn: (hours: number) => hours <= 84,
    },
    "fair": {
        label: "84-160 hours",
        compareFn: (hours: number) => hours <= 160,
    },
    "need-focus": {
        label: ">160 hours",
        compareFn: (hours: number) => hours > 160,
    },
} satisfies Record<
    React.ComponentProps<typeof InsightsBadge>["type"],
    {
        label: string;
        compareFn: (hours: number) => boolean;
    }
>;

const separateHoursAndMinutes = (hours: number) => {
    const a = Math.trunc(hours);
    const b = Math.trunc(60 * (hours - a));
    return { hours: a, minutes: b };
};

export default async function LeadTimeForChangeAnalytics() {
    const endDate = new Date();
    const startDate = subWeeks(endDate, 2);

    const response = await getLeadTimeForChangeAnalytics({
        startDate: formatISO(startDate, { representation: "date" }),
        endDate: formatISO(endDate, { representation: "date" }),
    });

    const data = extractApiData(response);

    if (
        !data?.currentPeriod ||
        !data?.previousPeriod ||
        (data.currentPeriod.leadTimeP75Hours === 0 &&
            data.currentPeriod.leadTimeP75Minutes === 0)
    ) {
        return <NoData />;
    }

    const [badge] = Object.entries(comparisonParameters).find(
        ([, { compareFn }]) =>
            compareFn(data?.currentPeriod?.leadTimeP75Hours ?? 0),
    ) ?? ["need-focus"];

    const currentPeriod = separateHoursAndMinutes(
        data?.currentPeriod?.leadTimeP75Hours,
    );
    const previousPeriod = separateHoursAndMinutes(
        data?.previousPeriod?.leadTimeP75Hours,
    );

    return (
        <>
            <PRCycleTimeAnalyticsHeader>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <InsightsBadge
                            type={
                                badge as React.ComponentProps<
                                    typeof InsightsBadge
                                >["type"]
                            }
                        />
                    </TooltipTrigger>

                    <TooltipContent
                        align="end"
                        className="w-96 p-5 text-sm shadow-2xl">
                        <span className="mb-4 flex font-bold">
                            PR Cycle Time Parameters
                        </span>

                        <div className="children:flex children:justify-between flex flex-col gap-2">
                            <div className="text-text-secondary">
                                <span>Hours</span>
                                <span>Level</span>
                            </div>

                            <Separator />

                            {Object.entries(comparisonParameters).map(
                                ([key, { label }]) => (
                                    <div key={key}>
                                        <span className="shrink-0">
                                            {label}
                                        </span>
                                        <DashedLine />
                                        <InsightsBadge
                                            className="pointer-events-none"
                                            type={
                                                key as React.ComponentProps<
                                                    typeof InsightsBadge
                                                >["type"]
                                            }
                                        />
                                    </div>
                                ),
                            )}
                        </div>
                    </TooltipContent>
                </Tooltip>
            </PRCycleTimeAnalyticsHeader>

            <CardContent className="flex items-center justify-start">
                <div className="text-3xl font-bold">
                    {currentPeriod.hours}
                    <small className="text-text-secondary">h</small>{" "}
                    {currentPeriod.minutes}
                    <small className="text-text-secondary">m</small>
                </div>
            </CardContent>

            <CardFooter className="text-text-secondary flex gap-1 text-xs">
                <span>
                    Last 2 weeks was {previousPeriod.hours}h{" "}
                    {previousPeriod.minutes}m
                </span>
                <PercentageDiff
                    status={getPercentageDiff(data?.comparison)}
                    mode="lower-is-better">
                    {data?.comparison?.percentageChange}%
                </PercentageDiff>
            </CardFooter>
        </>
    );
}
