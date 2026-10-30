"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@components/ui/skeleton";

// The Kodus Review tab is the cockpit's default landing tab, so its charts
// gate first paint. Each of these pulls in recharts (heavy); loading them via
// `next/dynamic({ ssr: false })` keeps recharts out of the initial route
// bundle and streams a skeleton until the chart hydrates — same pattern the
// productivity-tab slots already use (see e.g. @leadTimeBreakdownChart).
const loading = () => <Skeleton className="h-full min-h-72 w-full" />;

export const ReviewOperationalOutcomesChart = dynamic(
    () =>
        import("./review-operational-outcomes-chart").then(
            (c) => c.ReviewOperationalOutcomesChart,
        ),
    { ssr: false, loading },
);

export const WeeklyImplementationChart = dynamic(
    () =>
        import("./weekly-implementation-chart").then(
            (c) => c.WeeklyImplementationChart,
        ),
    { ssr: false, loading },
);

export const RateBySeverityChart = dynamic(
    () => import("./rate-by-severity-chart").then((c) => c.RateBySeverityChart),
    { ssr: false, loading },
);

export const FeedbackSection = dynamic(
    () => import("./feedback-section").then((c) => c.FeedbackSection),
    { ssr: false, loading },
);
