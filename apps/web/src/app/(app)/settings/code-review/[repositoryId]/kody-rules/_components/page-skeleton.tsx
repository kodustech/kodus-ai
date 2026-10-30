"use client";

import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import {
    SkeletonTable,
    SkeletonTabs,
} from "src/core/components/system/page-skeletons";

// Page-shell skeleton for Kody Rules. Mirrors the loaded layout — title +
// description, three header actions, the Review Rules / Memories tabs, the
// search + filters row, the severity chips and the rules table — with the
// same Page primitives, so nothing jumps when data lands.
export const KodyRulesPageSkeleton = () => {
    return (
        <Page.Root>
            <Page.Header>
                <Page.TitleContainer>
                    <Skeleton className="h-7 w-32" />
                    <Skeleton className="mt-2 h-4 w-[28rem] max-w-full" />
                    <Skeleton className="mt-1 h-4 w-[20rem] max-w-full" />
                </Page.TitleContainer>

                <div className="flex shrink-0 gap-2" aria-hidden>
                    <Skeleton className="h-9 w-32 rounded-lg" />
                    <Skeleton className="h-9 w-28 rounded-lg" />
                    <Skeleton className="h-9 w-28 rounded-lg" />
                </div>
            </Page.Header>

            <Page.Content>
                <SkeletonTabs count={2} />

                <div className="flex flex-wrap items-center gap-2" aria-hidden>
                    <Skeleton className="h-10 min-w-56 flex-1 rounded-xl" />
                    <Skeleton className="h-10 w-28 rounded-lg" />
                    <Skeleton className="h-10 w-20 rounded-lg" />
                </div>

                <div className="flex gap-2" aria-hidden>
                    <Skeleton className="h-7 w-20 rounded-md" />
                    <Skeleton className="h-7 w-16 rounded-md" />
                    <Skeleton className="h-7 w-24 rounded-md" />
                </div>

                <SkeletonTable rows={8} />
            </Page.Content>
        </Page.Root>
    );
};
