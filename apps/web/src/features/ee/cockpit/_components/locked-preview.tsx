import { Card } from "@components/ui/card";
import { Page } from "@components/ui/page";
import { Greeting } from "@components/system/greeting";

// The Cockpit's shape, with no values in it — this preview renders behind the
// LockedFeatureOverlay blur for orgs whose tier doesn't include the Cockpit,
// so it must never fetch real analytics.
//
// It used to carry sample numbers ("4.2/week", "+12% vs previous period") and
// hand-drawn charts. Blurred, they read as a real dashboard, which is exactly
// the problem: the one thing a locked screen must not do is show invented
// figures as if they were the org's. The metric names are real and stay — they
// are what's locked — and every value is an empty slot.
const METRICS = ["Deploy Frequency", "PR Cycle Time", "Bug Ratio", "PR Size"];

const CHARTS = ["Lead Time Breakdown", "PRs Opened vs Closed"];

export const CockpitLockedPreview = () => {
    return (
        <Page.Root>
            <Page.Header>
                <Page.Title><Greeting /></Page.Title>
                <div className="ml-auto flex items-center gap-2" aria-hidden>
                    <div className="bg-card-lv2 h-8 w-40 rounded-lg" />
                    <div className="bg-card-lv2 h-8 w-52 rounded-lg" />
                </div>
            </Page.Header>

            <Page.Content>
                <div className="flex flex-col gap-4">
                    <div className="flex gap-2" aria-hidden>
                        <div className="bg-card-lv2 h-9 w-32 rounded-lg" />
                        <div className="bg-card-lv2/50 h-9 w-32 rounded-lg" />
                    </div>

                    <div className="grid grid-cols-4 gap-2 *:h-56">
                        {METRICS.map((metric) => (
                            <Card
                                key={metric}
                                color="lv1"
                                className="flex flex-col justify-between p-6">
                                <span className="text-text-secondary text-sm">
                                    {metric}
                                </span>
                                <div className="flex flex-col gap-2">
                                    <span className="text-text-tertiary text-2xl font-semibold">
                                        —
                                    </span>
                                    <div
                                        aria-hidden
                                        className="bg-card-lv2 h-3 w-28 rounded"
                                    />
                                </div>
                            </Card>
                        ))}
                    </div>

                    <div className="grid grid-cols-2 gap-2 *:h-[400px]">
                        {CHARTS.map((chart) => (
                            <Card
                                key={chart}
                                color="lv1"
                                className="flex flex-col gap-4 p-6">
                                <span className="text-text-secondary text-sm">
                                    {chart}
                                </span>
                                <div
                                    aria-hidden
                                    className="bg-card-lv2/40 min-h-0 flex-1 rounded-lg"
                                />
                            </Card>
                        ))}
                    </div>
                </div>
            </Page.Content>
        </Page.Root>
    );
};
