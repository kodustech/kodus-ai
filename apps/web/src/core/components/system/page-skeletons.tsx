"use client";

import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";
import { cn } from "src/core/utils/components";

// Loading states that mirror the screen they stand in for: same Page
// primitives, same bands, same row heights, so the swap to real content is a
// fill-in rather than a layout jump. Nothing here fetches — `loading.tsx`
// files and Suspense fallbacks compose these.

const TAB_WIDTHS = [4.5, 6, 5, 7, 6.5];

/** Underline-tab strip (LinkTabs / DS Tabs voice), `count` labels wide. */
export const SkeletonTabs = ({
    count = 3,
    className,
}: {
    count?: number;
    className?: string;
}) => (
    <div
        className={cn(
            "border-card-lv3/60 flex h-10 items-center gap-1 border-b-2",
            className,
        )}
        aria-hidden>
        {Array.from({ length: count }).map((_, i) => (
            <div key={i} className="flex h-10 items-center px-4">
                <Skeleton
                    className="h-4"
                    style={{ width: `${TAB_WIDTHS[i % TAB_WIDTHS.length]}rem` }}
                />
            </div>
        ))}
    </div>
);

/** Search field + two filter buttons on one wrapping row. */
export const SkeletonToolbar = ({ filters = 2 }: { filters?: number }) => (
    <div className="flex flex-wrap items-center gap-2" aria-hidden>
        <Skeleton className="h-9 min-w-[18rem] flex-1 rounded-xl" />
        {Array.from({ length: filters }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-28 rounded-lg" />
        ))}
    </div>
);

/** List rows: leading icon, two text lines, two trailing pills. */
export const SkeletonRows = ({
    rows = 6,
    className,
}: {
    rows?: number;
    className?: string;
}) => (
    <div
        className={cn("divide-card-lv3/30 flex flex-col divide-y", className)}
        role="status"
        aria-live="polite"
        aria-label="Loading">
        {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4">
                <Skeleton className="size-4 shrink-0 rounded" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-3 w-3/5" />
                </div>
                <Skeleton className="h-5 w-16 rounded-md" />
                <Skeleton className="h-5 w-20 rounded-md" />
            </div>
        ))}
    </div>
);

/** Bordered table card: header labels row + `rows` list rows. */
export const SkeletonTable = ({
    rows = 8,
    className,
}: {
    rows?: number;
    className?: string;
}) => (
    <div
        className={cn(
            "border-card-lv3/60 bg-card-lv1 overflow-hidden rounded-xl border",
            className,
        )}>
        <div
            className="border-card-lv3/40 flex items-center gap-6 border-b px-5 py-3"
            aria-hidden>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="ml-auto h-3 w-16" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-14" />
        </div>
        <SkeletonRows rows={rows} />
    </div>
);

/** Settings-style card: title, helper lines, a control on the right. */
export const SkeletonCard = ({
    lines = 2,
    className,
}: {
    lines?: number;
    className?: string;
}) => (
    <div
        className={cn(
            "border-card-lv3/60 bg-card-lv1 flex items-start justify-between gap-8 rounded-xl border p-6",
            className,
        )}
        aria-hidden>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-48" />
            {Array.from({ length: lines }).map((_, i) => (
                <Skeleton
                    key={i}
                    className={cn("h-4", i === lines - 1 ? "w-3/5" : "w-11/12")}
                />
            ))}
        </div>
        <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
    </div>
);

/**
 * Generic section page: title + description, two header actions, a toolbar
 * and a table. The `(app)` segment falls back to this the instant a
 * navigation starts, before the target section's own layout has resolved.
 */
export const AppPageSkeleton = () => (
    <Page.Root>
        <Page.Header>
            <Page.TitleContainer>
                <Skeleton className="h-7 w-44" />
                <Skeleton className="mt-2 h-4 w-[26rem] max-w-full" />
            </Page.TitleContainer>
            <div className="flex gap-2" aria-hidden>
                <Skeleton className="h-9 w-28 rounded-lg" />
                <Skeleton className="h-9 w-24 rounded-lg" />
            </div>
        </Page.Header>
        <Page.Content>
            <SkeletonToolbar />
            <SkeletonTable />
        </Page.Content>
    </Page.Root>
);

/**
 * Reviews (Pull requests / CLI): the compact band with the source tabs +
 * count on the left and a pulse chip on the right, then toolbar and table.
 * `tabs` lets the caller render the real ReviewsSourceTabs so the strip
 * doesn't flash between the skeleton and the page.
 */
export const ReviewsPageSkeleton = ({ tabs }: { tabs?: React.ReactNode }) => (
    <Page.Root scrollable={false} className="min-h-0 gap-3 pt-6 pb-0">
        <Page.Header>
            <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="flex items-center gap-3">
                    {tabs ?? (
                        <SkeletonTabs count={2} className="-ml-4 border-b-0" />
                    )}
                    <Skeleton className="h-4 w-16" />
                </div>
                <div className="flex items-center gap-1.5" aria-hidden>
                    <Skeleton className="h-7 w-32 rounded-md" />
                    <Skeleton className="h-7 w-32 rounded-md" />
                </div>
            </div>
        </Page.Header>
        <Page.Content className="min-h-0 gap-3">
            <SkeletonToolbar filters={3} />
            <SkeletonTable rows={9} className="min-h-0 flex-1" />
        </Page.Content>
    </Page.Root>
);

/** A settings tab page: title + description, one header action, cards. */
export const SettingsPageSkeleton = ({ cards = 3 }: { cards?: number }) => (
    <Page.Root>
        <Page.Header>
            <Page.TitleContainer>
                <Skeleton className="h-7 w-48" />
                <Skeleton className="mt-2 h-4 w-[28rem] max-w-full" />
            </Page.TitleContainer>
            <Page.HeaderActions>
                <Skeleton className="h-9 w-32 rounded-lg" />
            </Page.HeaderActions>
        </Page.Header>
        <Page.Content>
            {Array.from({ length: cards }).map((_, i) => (
                <SkeletonCard key={i} lines={i === 0 ? 3 : 2} />
            ))}
        </Page.Content>
    </Page.Root>
);

/**
 * AI providers: two description lines, a three-tab strip, then the connected
 * provider cards. Shaped like the real page so the tabs don't jump when the
 * data lands.
 */
export const AiProvidersPageSkeleton = () => (
    <Page.Root>
        <Page.Header>
            <Page.TitleContainer>
                <Skeleton className="h-7 w-44" />
                <Skeleton className="mt-2 h-4 w-[34rem] max-w-full" />
                <Skeleton className="mt-1.5 h-4 w-[24rem] max-w-full" />
            </Page.TitleContainer>
        </Page.Header>
        <Page.Content>
            <SkeletonTabs count={3} />
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Skeleton className="h-5 w-56" />
                <Skeleton className="h-8 w-44 rounded-lg" />
            </div>
            <SkeletonCard lines={2} />
            <SkeletonCard lines={2} />
        </Page.Content>
    </Page.Root>
);

/** Organization settings: title + actions, then fixed-width cards. */
export const OrganizationPageSkeleton = () => (
    <Page.Root>
        <Page.Header>
            <Skeleton className="h-7 w-48" />
            <Page.HeaderActions>
                <Skeleton className="h-9 w-40 rounded-lg" />
                <Skeleton className="h-9 w-32 rounded-lg" />
            </Page.HeaderActions>
        </Page.Header>
        <Page.Content className="gap-8">
            <SkeletonCard className="w-md max-w-full" lines={3} />
            <SkeletonCard className="w-md max-w-full" />
            <SkeletonCard className="w-md max-w-full" />
        </Page.Content>
    </Page.Root>
);

/**
 * Cockpit: greeting + pickers, the tab strip, then the Kody review tab's
 * layout (its default tab): four stat cards, a wide chart, two charts, a
 * table. Also the Suspense fallback of the cockpit layout while the
 * license and analytics status resolve.
 */
export const CockpitPageSkeleton = () => (
    <Page.Root>
        <Page.Header>
            <Skeleton className="h-7 w-56" />
            <div className="ml-auto flex items-center gap-2" aria-hidden>
                <Skeleton className="h-9 w-44 rounded-lg" />
                <Skeleton className="h-9 w-52 rounded-lg" />
                <Skeleton className="size-9 rounded-lg" />
            </div>
        </Page.Header>
        <Page.Content>
            <SkeletonTabs count={3} />
            <div className="flex flex-col gap-2" aria-hidden>
                <div className="grid grid-cols-4 gap-2">
                    <Skeleton className="h-32" />
                    <Skeleton className="h-32" />
                    <Skeleton className="h-32" />
                    <Skeleton className="h-32" />
                </div>
                <Skeleton className="h-80" />
                <div className="grid grid-cols-2 gap-2">
                    <Skeleton className="h-72" />
                    <Skeleton className="h-72" />
                </div>
            </div>
        </Page.Content>
    </Page.Root>
);

/** Issues: cockpit strip, title + filters, virtualised table. */
export const IssuesPageSkeleton = ({ tabs }: { tabs?: React.ReactNode }) => (
    <Page.Root className="overflow-hidden pb-0">
        <Page.Header>
            {tabs ?? <SkeletonTabs count={3} className="w-full" />}
        </Page.Header>
        <Page.Header>
            <div className="flex items-center gap-5">
                <Skeleton className="h-7 w-24" />
                <div className="flex items-center gap-3" aria-hidden>
                    <Skeleton className="h-9 w-28 rounded-lg" />
                    <Skeleton className="h-4 w-32" />
                </div>
            </div>
            <Skeleton className="h-9 w-40 rounded-lg" />
        </Page.Header>
        <Page.Content className="px-0">
            <div
                className="border-card-lv3/40 flex items-center gap-6 border-y px-8 py-3"
                aria-hidden>
                <Skeleton className="h-3 w-40" />
                <Skeleton className="ml-auto h-3 w-20" />
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-24" />
            </div>
            <SkeletonRows rows={10} className="px-3" />
        </Page.Content>
    </Page.Root>
);

/** Kody Rules library: title + search, bucket rail + card grid. */
export const LibraryPageSkeleton = () => (
    <Page.Root className="w-full pb-0">
        {/* Same cap as the loaded page: a skeleton with a width of its own
            makes the content jump sideways the moment it arrives. */}
        <Page.Header>
            <Page.TitleContainer>
                <Skeleton className="h-8 w-56" />
                <Skeleton className="mt-2 h-4 w-[30rem] max-w-full" />
            </Page.TitleContainer>
            <Skeleton className="h-10 w-72 rounded-xl" />
        </Page.Header>
        <Page.Content className="pt-8">
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-[280px_1fr]">
                <div className="flex flex-col gap-2" aria-hidden>
                    {Array.from({ length: 8 }).map((_, i) => (
                        <Skeleton key={i} className="h-9 w-full rounded-lg" />
                    ))}
                </div>
                <div className="flex flex-col gap-8">
                    {Array.from({ length: 2 }).map((_, s) => (
                        <div key={s} className="flex flex-col gap-4">
                            <Skeleton className="h-6 w-48" />
                            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <div
                                        key={i}
                                        className="border-card-lv3/60 bg-card-lv1 flex flex-col gap-3 rounded-xl border p-5"
                                        aria-hidden>
                                        <div className="flex gap-2">
                                            <Skeleton className="h-5 w-16 rounded-md" />
                                            <Skeleton className="h-5 w-20 rounded-md" />
                                        </div>
                                        <Skeleton className="h-5 w-3/4" />
                                        <Skeleton className="h-4 w-full" />
                                        <Skeleton className="h-4 w-5/6" />
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </Page.Content>
    </Page.Root>
);
