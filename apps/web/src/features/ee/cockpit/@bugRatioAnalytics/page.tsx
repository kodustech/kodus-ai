import { CardContent, CardFooter } from "@components/ui/card";
import { DashedLine } from "@components/ui/dashed-line";
import { Separator } from "@components/ui/separator";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { formatISO, subWeeks } from "date-fns";
import { getCodeHealthBugRatioAnalytics } from "src/features/ee/cockpit/_services/analytics/code-health/fetch";
import { getPercentageDiff } from "src/features/ee/cockpit/_services/analytics/utils";

import { InsightsBadge } from "../_components/insights-badge";
import { PercentageDiff } from "../_components/percentage-diff";
import { extractApiData } from "../_helpers/api-data-extractor";
import { BugRatioAnalyticsHeader } from "./_components/header";
import NoData from "./_components/no-data";

const comparisonParameters = {
    "elite": {
        label: "<5%",
        compareFn: (value: number) => value < 5,
    },
    "high": {
        label: "5%-10%",
        compareFn: (value: number) => value <= 10,
    },
    "fair": {
        label: "10%-20%",
        compareFn: (value: number) => value <= 20,
    },
    "need-focus": {
        label: ">20%",
        compareFn: (value: number) => value > 20,
    },
} satisfies Record<
    React.ComponentProps<typeof InsightsBadge>["type"],
    {
        label: string;
        compareFn: (value: number) => boolean;
    }
>;

export default async function BugRatioAnalytics() {
    const endDate = new Date();
    const startDate = subWeeks(endDate, 2);

    const response = await getCodeHealthBugRatioAnalytics({
        startDate: formatISO(startDate, { representation: "date" }),
        endDate: formatISO(endDate, { representation: "date" }),
    });
    const data = extractApiData(response);

    if (
        !data?.currentPeriod ||
        !data?.previousPeriod ||
        (data.currentPeriod.ratio === 0 && data.previousPeriod.ratio === 0)
    ) {
        return <NoData />;
    }

    const [badge] = Object.entries(comparisonParameters).find(
        ([, { compareFn }]) => compareFn(data?.currentPeriod?.ratio ?? 0),
    ) ?? ["need-focus"];

    return (
        <>
            <BugRatioAnalyticsHeader>
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
                        className="w-96 p-5 text-sm shadow-2xl"
                        align="end">
                        <span className="mb-4 flex font-bold">
                            Bug Ratio Parameters
                        </span>

                        <div className="children:flex children:justify-between flex flex-col gap-2">
                            <div className="text-text-secondary">
                                <span>Percentage</span>
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
            </BugRatioAnalyticsHeader>

            <CardContent className="flex items-center justify-start">
                <div className="text-3xl font-bold">
                    {data?.currentPeriod?.ratio}
                    <small>%</small>
                </div>
            </CardContent>

            <CardFooter className="text-text-secondary flex gap-1 text-xs">
                <span>Last 2 weeks was {data?.previousPeriod?.ratio}%</span>
                <PercentageDiff
                    status={getPercentageDiff(data?.comparison)}
                    mode="lower-is-better">
                    {data?.comparison?.percentageChange}%
                </PercentageDiff>
            </CardFooter>
        </>
    );
}
