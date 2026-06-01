"use client";

import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";

import { KodyRulesListSkeleton } from "./list-skeleton";

// Page-shell skeleton for Kody Rules. Mirrors the real layout so the
// page doesn't visually jump when data lands: breadcrumb row, title +
// description, action buttons, tabs, search/filters row, then a grid of
// rule-card skeletons.
//
// Reuses Page.Root / Page.Header / Page.Content so spacing, container
// width and breakpoints are identical to the loaded page — otherwise
// the skeleton sits flush-left and the content jumps when it lands.
export const KodyRulesPageSkeleton = () => {
    return (
        <Page.Root>
            <Page.Header>
                <Skeleton className="h-4 w-40" />
            </Page.Header>

            <Page.Header>
                <Page.TitleContainer>
                    <Skeleton className="h-7 w-32" />
                    <Skeleton className="mt-2 h-4 w-[28rem] max-w-full" />
                    <Skeleton className="mt-1 h-4 w-[20rem] max-w-full" />
                </Page.TitleContainer>

                <div className="flex shrink-0 gap-2">
                    <Skeleton className="h-9 w-28" />
                    <Skeleton className="h-9 w-28" />
                </div>
            </Page.Header>

            <Page.Content>
                <div className="flex gap-4 border-b">
                    <Skeleton className="h-8 w-28" />
                    <Skeleton className="h-8 w-24" />
                    <Skeleton className="h-8 w-28" />
                </div>

                <Skeleton className="h-4 w-3/4" />

                <div className="flex gap-2">
                    <Skeleton className="h-10 flex-1" />
                    <Skeleton className="h-10 w-24" />
                </div>

                <KodyRulesListSkeleton />
            </Page.Content>
        </Page.Root>
    );
};
