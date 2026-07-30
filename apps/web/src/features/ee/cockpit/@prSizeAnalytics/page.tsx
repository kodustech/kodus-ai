import { CardContent, CardFooter } from "@components/ui/card";
import { DashedLine } from "@components/ui/dashed-line";
import { Separator } from "@components/ui/separator";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { formatISO, subWeeks } from "date-fns";
import { extractApiData } from "src/features/ee/cockpit/_helpers/api-data-extractor";
import { getPRSizeAnalytics } from "src/features/ee/cockpit/_services/analytics/productivity/fetch";
import { getPercentageDiff } from "src/features/ee/cockpit/_services/analytics/utils";

import { InsightsBadge } from "../_components/insights-badge";
import { PercentageDiff } from "../_components/percentage-diff";
import { PRSizeAnalyticsHeader } from "./_components/header";
import NoData from "./_components/no-data";

const comparisonParameters = {
    "elite": {
        label: "<250 lines",
        compareFn: (value: number) => value < 250,
    },
    "high": {
        label: "250-400 lines",
        compareFn: (value: number) => value <= 400,
    },
    "fair": {
        label: "400-600 lines",
        compareFn: (value: number) => value <= 600,
    },
    "need-focus": {
        label: ">600 lines",
        compareFn: (value: number) => value > 600,
    },
} satisfies Record<
    React.ComponentProps<typeof InsightsBadge>["type"],
    {
        label: string;
        compareFn: (value: number) => boolean;
    }
>;

export default async function PRSizeAnalytics() {
    const endDate = new Date();
    const startDate = subWeeks(endDate, 2);

    const response = await getPRSizeAnalytics({
        startDate: formatISO(startDate, { representation: "date" }),
        endDate: formatISO(endDate, { representation: "date" }),
    });

    const data = extractApiData(response);
    if (
        !data?.currentPeriod ||
        !data?.previousPeriod ||
        (data.currentPeriod.totalPRs === 0 &&
            data.previousPeriod.totalPRs === 0)
    ) {
        return <NoData />;
    }

    const [badge] = Object.entries(comparisonParameters).find(
        ([, { compareFn }]) =>
            compareFn(data?.currentPeriod?.averagePRSize ?? 0),
    ) ?? ["need-focus"];

    return (
        <>
            <PRSizeAnalyticsHeader>
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
                            PR Size Parameters
                        </span>

                        <div className="children:flex children:justify-between flex flex-col gap-2">
                            <div className="text-text-secondary">
                                <span>Lines</span>
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
            </PRSizeAnalyticsHeader>

            <CardContent className="flex items-center justify-start">
                <div className="text-3xl font-bold">
                    {data?.currentPeriod?.averagePRSize}
                </div>
            </CardContent>

            <CardFooter className="text-text-secondary flex gap-1 text-xs">
                <span>
                    Last 2 weeks was {data?.previousPeriod?.averagePRSize}
                </span>
                <PercentageDiff
                    mode="lower-is-better"
                    status={getPercentageDiff(data?.comparison)}>
                    {data?.comparison?.percentageChange}%
                </PercentageDiff>
            </CardFooter>
        </>
    );
}
