import Link from "next/link";
import { Card, CardTitle } from "@components/ui/card";

import type {
    IgnoredCriticalsHighlight,
    NegativeVoteRateHighlight,
    ReviewOperationalMetrics,
} from "../../_services/analytics/review/fetch";
import { PercentageDiff } from "../../_components/percentage-diff";

const pct = (value: number) => `${Math.round(value * 100)}%`;
const count = (value: number) => Intl.NumberFormat("en-US").format(value);

const trendStatus = (trend: "improved" | "worsened" | "unchanged") => {
    if (trend === "improved") return "good";
    if (trend === "worsened") return "bad";
    return "neutral";
};

const MetricCard = ({
    title,
    children,
    footer,
    aside,
}: React.PropsWithChildren & {
    title: string;
    footer?: React.ReactNode;
    aside?: React.ReactNode;
}) => (
    <Card color="lv1" className="min-h-40 justify-between gap-2 p-5">
        <CardTitle className="text-text-secondary text-xs leading-snug font-semibold">
            {title}
        </CardTitle>
        <div className="flex items-end justify-between gap-3">
            <div className="text-3xl font-bold">{children}</div>
            {aside && (
                <div className="flex justify-end pb-1 text-xs font-semibold">
                    {aside}
                </div>
            )}
        </div>
        {footer && (
            <div className="text-text-tertiary text-xs leading-snug">
                {footer}
            </div>
        )}
    </Card>
);

const WoWDiff = ({
    value,
    unit,
    trend,
    mode,
}: {
    value: number;
    unit: "%" | "pp";
    trend: "improved" | "worsened" | "unchanged";
    mode: React.ComponentProps<typeof PercentageDiff>["mode"];
}) => {
    const formattedValue = `${Math.abs(value)}${unit === "pp" ? " pp" : "%"}`;

    return (
        <PercentageDiff mode={mode} status={trendStatus(trend)}>
            {formattedValue}
        </PercentageDiff>
    );
};

export const ReviewCards = ({
    sent,
    implemented,
    negativeVoteRate,
    ignoredCriticals,
    operationalMetrics,
}: {
    sent: number;
    implemented: number;
    negativeVoteRate: NegativeVoteRateHighlight | undefined;
    ignoredCriticals: IgnoredCriticalsHighlight | undefined;
    operationalMetrics?: ReviewOperationalMetrics | null;
}) => {
    const rate = sent > 0 ? implemented / sent : 0;
    const current = negativeVoteRate?.currentPeriod;
    const trend = negativeVoteRate?.comparison?.trend;
    const criticalsCount = ignoredCriticals?.count ?? 0;

    // A rate over a handful of reactions is statistical noise — below this
    // we show raw counts instead of a percentage.
    const MIN_REACTIONS_FOR_RATE = 10;
    const totalReactions =
        (current?.thumbsUp ?? 0) + (current?.thumbsDown ?? 0);
    const lowSample = totalReactions < MIN_REACTIONS_FOR_RATE;
    const gridClassName = operationalMetrics
        ? "grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-5"
        : "grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4";
    const formattedImplemented = count(implemented);
    const formattedSent = count(sent);
    const suggestionsFooter = `${formattedImplemented} of ${formattedSent} suggestions implemented`;

    return (
        <div className={gridClassName}>
            <MetricCard title="Implementation rate" footer={suggestionsFooter}>
                {pct(rate)}
            </MetricCard>

            <MetricCard title="Suggestions sent" footer="in this period">
                {count(sent)}
            </MetricCard>

            {operationalMetrics && (
                <MetricCard
                    title="PRs processed"
                    footer={`${count(operationalMetrics.previousPeriod.processedPRs)} previous period`}
                    aside={
                        <WoWDiff
                            value={
                                operationalMetrics.comparison.processedPRs
                                    .percentageChange
                            }
                            unit="%"
                            trend={
                                operationalMetrics.comparison.processedPRs.trend
                            }
                            mode="higher-is-better"
                        />
                    }>
                    {count(operationalMetrics.currentPeriod.processedPRs)}
                </MetricCard>
            )}

            <MetricCard
                title="Negative vote rate"
                footer={
                    totalReactions === 0
                        ? "no feedback in this period"
                        : lowSample
                          ? `only ${totalReactions} reactions — too few to be a rate`
                          : `${current?.thumbsDown ?? 0} 👎 · ${current?.thumbsUp ?? 0} 👍 in this period`
                }>
                {totalReactions === 0 ? (
                    <span className="text-text-tertiary text-2xl">—</span>
                ) : lowSample ? (
                    // Below the threshold a percentage is noise — show the raw
                    // counts instead so it doesn't read as a real rate.
                    <span className="flex items-baseline gap-2 text-2xl">
                        <span className="text-danger">
                            {current?.thumbsDown ?? 0} 👎
                        </span>
                        <span className="text-text-tertiary text-lg">
                            / {totalReactions}
                        </span>
                    </span>
                ) : (
                    <span className="flex items-baseline gap-3">
                        {pct(current?.negativeRate ?? 0)}
                        {trend && trend !== "unchanged" && (
                            <span className="text-sm font-semibold">
                                <PercentageDiff
                                    mode="lower-is-better"
                                    status={
                                        trend === "improved" ? "good" : "bad"
                                    }>
                                    {Math.abs(
                                        negativeVoteRate?.comparison
                                            ?.percentageChange ?? 0,
                                    )}
                                    %
                                </PercentageDiff>
                            </span>
                        )}
                    </span>
                )}
            </MetricCard>

            <Link href="#themes-by-category" className="block" scroll>
                <Card
                    color="lv1"
                    className="border-danger/40 hover:border-danger/70 min-h-40 justify-between gap-2 border p-5 transition-colors">
                    <CardTitle className="text-text-secondary text-xs leading-snug font-semibold">
                        Critical suggestions not yet addressed
                    </CardTitle>
                    <div className="text-danger text-3xl font-bold">
                        {criticalsCount}
                    </div>
                    <div className="text-text-tertiary text-xs leading-snug">
                        on merged PRs · see which themes get ignored ↓
                    </div>
                </Card>
            </Link>
        </div>
    );
};
