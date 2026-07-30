"use client";

import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";

// Content-only skeleton (no Page.Root/Header) so it can be reused by both the
// route-level loading.tsx (via TokenUsagePageSkeleton below) AND
// TokenUsagePageClient's pre-mount state — which already renders inside
// <Page.Content> and would otherwise flash an empty body between SSR and client
// mount (returning null). Mirrors the revamped layout: filters row, the KPI row
// (5 summary cards) and the usage chart.
export const TokenUsageContentSkeleton = () => {
    return (
        <>
            <p className="text-text-secondary animate-pulse text-sm">
                Preparing your usage data…
            </p>

            {/* filters row: models multiselect + "Filter by" select */}
            <div className="flex gap-4">
                <Skeleton className="h-10 w-[300px] max-w-[350px]" />
                <Skeleton className="h-10 w-[200px]" />
            </div>

            {/* KPI row — one row, equal columns */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-28 w-full rounded-xl" />
                ))}
            </div>

            {/* usage chart */}
            <Skeleton className="h-[440px] w-full rounded-xl" />
        </>
    );
};

export const TokenUsagePageSkeleton = () => {
    return (
        <Page.Root>
            <Page.Header className="max-w-full px-6">
                <Page.Title>Token Usage</Page.Title>
            </Page.Header>

            <Page.Content className="max-w-full px-6">
                <TokenUsageContentSkeleton />
            </Page.Content>
        </Page.Root>
    );
};
