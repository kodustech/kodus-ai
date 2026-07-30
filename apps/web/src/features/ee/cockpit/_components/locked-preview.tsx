import { Card } from "@components/ui/card";
import { Page } from "@components/ui/page";
import { greeting } from "src/core/utils/helpers";

// Static sample values only — this preview renders behind the
// LockedFeatureOverlay blur for orgs whose tier doesn't include the
// Cockpit, so it must never fetch real analytics.
const SAMPLE_STATS = [
    { label: "Deploy Frequency", value: "4.2/week", diff: "+12%" },
    { label: "PR Cycle Time", value: "26h", diff: "-8%" },
    { label: "Bug Ratio", value: "12%", diff: "-3%" },
    { label: "PR Size", value: "214 lines", diff: "-15%" },
];

const SAMPLE_LINE = [42, 38, 45, 40, 52, 48, 58, 54, 63, 60, 70, 66];
const SAMPLE_BARS = [35, 55, 42, 68, 50, 74, 61, 80];

export const CockpitLockedPreview = () => {
    return (
        <Page.Root>
            <Page.Header className="max-w-full px-6">
                <Page.Title>{greeting()}</Page.Title>
                <div className="ml-auto flex items-center gap-2">
                    <div className="bg-card-lv2 h-8 w-40 rounded-lg" />
                    <div className="bg-card-lv2 h-8 w-52 rounded-lg" />
                </div>
            </Page.Header>

            <Page.Content className="max-w-full px-6">
                <div className="flex flex-col gap-4">
                    <div className="flex gap-2">
                        <div className="bg-card-lv2 h-9 w-32 rounded-lg" />
                        <div className="bg-card-lv2/50 h-9 w-32 rounded-lg" />
                    </div>

                    <div className="grid grid-cols-4 gap-2 *:h-56">
                        {SAMPLE_STATS.map((stat) => (
                            <Card
                                key={stat.label}
                                color="lv1"
                                className="flex flex-col justify-between p-6">
                                <span className="text-text-secondary text-sm">
                                    {stat.label}
                                </span>
                                <div className="flex flex-col gap-1">
                                    <span className="text-3xl font-semibold">
                                        {stat.value}
                                    </span>
                                    <span className="text-success text-xs">
                                        {stat.diff} vs previous period
                                    </span>
                                </div>
                            </Card>
                        ))}
                    </div>

                    <div className="grid grid-cols-2 gap-2 *:h-[400px]">
                        <Card color="lv1" className="flex flex-col gap-4 p-6">
                            <span className="text-text-secondary text-sm">
                                Lead Time Breakdown
                            </span>
                            <svg
                                className="min-h-0 flex-1"
                                viewBox="0 0 240 100"
                                preserveAspectRatio="none">
                                <polyline
                                    fill="none"
                                    stroke="var(--color-primary-light)"
                                    strokeWidth="2"
                                    points={SAMPLE_LINE.map(
                                        (y, i) =>
                                            `${(i / (SAMPLE_LINE.length - 1)) * 240},${100 - y}`,
                                    ).join(" ")}
                                />
                            </svg>
                        </Card>

                        <Card color="lv1" className="flex flex-col gap-4 p-6">
                            <span className="text-text-secondary text-sm">
                                PRs Opened vs Closed
                            </span>
                            <svg
                                className="min-h-0 flex-1"
                                viewBox="0 0 240 100"
                                preserveAspectRatio="none">
                                {SAMPLE_BARS.map((height, i) => (
                                    <rect
                                        key={i}
                                        x={i * 30 + 6}
                                        y={100 - height}
                                        width={18}
                                        height={height}
                                        rx={2}
                                        fill="var(--color-primary-light)"
                                        opacity={0.7}
                                    />
                                ))}
                            </svg>
                        </Card>
                    </div>
                </div>
            </Page.Content>
        </Page.Root>
    );
};
