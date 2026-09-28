"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@components/ui/button";
import { Skeleton } from "@components/ui/skeleton";
import { Spinner } from "@components/ui/spinner";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GitPullRequestIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import { PR_ROW_GRID, PrListItem } from "./pr-list-item";
import type { PullRequestExecutionGroup } from "./types";

// How many pages the list may pull by itself, per scroll, to fill the window.
// Enough for a very selective filter to find something to show; short of
// letting one mount walk the whole history unattended.
const AUTO_PULL_BUDGET = 10;

interface PrDataTableProps {
    data: PullRequestExecutionGroup[];
    loading?: boolean;
    hasNextPage?: boolean;
    isFetchingNextPage?: boolean;
    fetchNextPage?: () => void;
    fetchNextPageFailed?: boolean;
    hasActiveFilters?: boolean;
    onClearFilters?: () => void;
}

export const PrDataTable = ({
    data,
    loading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    fetchNextPageFailed,
    hasActiveFilters,
    onClearFilters,
}: PrDataTableProps) => {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const loadMoreRef = useRef<HTMLDivElement | null>(null);
    const autoPulls = useRef(0);
    const [autoPullExhausted, setAutoPullExhausted] = useState(false);

    const virtualizer = useVirtualizer({
        count: data.length,
        getScrollElement: () => scrollRef.current,
        // Collapsed row height; measureElement corrects it (and any expanded
        // row) to the real value via ResizeObserver.
        estimateSize: () => 66,
        overscan: 8,
        getItemKey: (index) => data[index]?.prId ?? index,
    });

    // BOTH triggers go through here. They used to be independent: the budget
    // and the after-failure guard lived only in the settle effect below, while
    // the observer called fetchNextPage directly — and because that observer
    // is rebuilt on every `isFetchingNextPage` change and fires again on
    // observe(), an already-visible sentinel re-fired it on each settle. So a
    // failed page retried instantly and forever (the query sets `retry:
    // false`), and the budget bounded nothing. One door, one set of locks.
    const requestMore = useCallback(() => {
        if (!fetchNextPage || !hasNextPage || isFetchingNextPage) return;
        if (fetchNextPageFailed) return;
        if (autoPulls.current >= AUTO_PULL_BUDGET) {
            setAutoPullExhausted(true);
            return;
        }
        autoPulls.current += 1;
        fetchNextPage();
    }, [fetchNextPage, hasNextPage, isFetchingNextPage, fetchNextPageFailed]);

    // Held in a ref so the observer below can be rebuilt without the callback
    // it captured going stale.
    const requestMoreRef = useRef(requestMore);
    requestMoreRef.current = requestMore;

    useEffect(() => {
        const node = loadMoreRef.current;
        const root = scrollRef.current;
        if (!node || !root || !fetchNextPage) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0]?.isIntersecting) {
                    requestMoreRef.current();
                }
            },
            { root, rootMargin: "0px 0px 400px 0px" },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

    // A page can arrive SHORTER than the window it has to fill: post-query
    // filters discard rows, and the backend caps how far one request will scan
    // rather than draining the whole history for a selective filter. When that
    // leaves the list not tall enough to scroll, the observer above never gets
    // another intersection to react to — the sentinel just sits in view — and
    // the reader is stranded on a handful of rows with blank space under them
    // and no way to ask for more.
    //
    // So also pull on settle: whenever a fetch finishes and the sentinel is
    // still on screen with more behind it, fetch again. It stops on its own as
    // soon as the content is tall enough to push the sentinel out of view,
    // which is the point where scrolling takes over.
    //
    // Two things it must NOT do on its own. A page that fails leaves the cursor
    // (and `hasNextPage`) untouched, so re-firing on settle would retry it
    // instantly, forever, with no backoff — the query has `retry: false`. And a
    // filter selective enough that every page comes back empty would keep it
    // reading history with nothing to show for it. So: never auto-pull after a
    // failure, and spend at most AUTO_PULL_BUDGET pulls before handing the
    // decision to the reader, who gets a button and their budget back the
    // moment they scroll.
    useEffect(() => {
        const node = loadMoreRef.current;
        const root = scrollRef.current;
        if (!node || !root) return;

        const nodeTop = node.getBoundingClientRect().top;
        const rootBottom = root.getBoundingClientRect().bottom;
        if (nodeTop > rootBottom) return;

        requestMore();
    }, [
        requestMore,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        fetchNextPageFailed,
        data.length,
    ]);

    // A scroll is the reader asking to go further, so the budget resets. It
    // can't reset on intersection instead: the observer above is rebuilt on
    // every fetch and fires again on observe, which would refill the budget
    // without anyone asking.
    useEffect(() => {
        const root = scrollRef.current;
        if (!root) return;
        const onScroll = () => {
            autoPulls.current = 0;
            setAutoPullExhausted(false);
        };
        root.addEventListener("scroll", onScroll, { passive: true });
        return () => root.removeEventListener("scroll", onScroll);
        // `loading` and `data.length`, not []: the first commit of a cold load
        // returns the skeleton before this scroller exists, so an effect that
        // only ran once attached to nothing and the budget never got its
        // reset — exactly the reader-controlled escape hatch it exists for.
    }, [loading, data.length]);

    const loadMore = () => {
        autoPulls.current = 0;
        setAutoPullExhausted(false);
        fetchNextPage?.();
    };

    if (loading) {
        return (
            <div className="border-card-lv3/40 bg-card-lv1/50 divide-card-lv3/30 flex flex-col divide-y overflow-hidden rounded-xl border">
                {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="flex items-start gap-3 px-5 py-4">
                        <Skeleton className="mt-1 size-4 shrink-0 rounded" />
                        <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-2/5" />
                            <Skeleton className="h-3 w-3/5" />
                        </div>
                        <div className="flex flex-col items-end gap-2">
                            <Skeleton className="h-5 w-16 rounded-md" />
                            <Skeleton className="h-4 w-24 rounded" />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (!data.length) {
        return (
            <div className="border-card-lv3/40 bg-card-lv1/50 flex flex-col items-center justify-center gap-3 rounded-xl border py-16 text-center">
                <div className="bg-card-lv2/60 text-text-tertiary flex size-11 items-center justify-center rounded-full">
                    <GitPullRequestIcon className="size-5" />
                </div>
                {hasActiveFilters ? (
                    <>
                        <p className="text-text-secondary text-sm">
                            No pull requests match these filters.
                        </p>
                        {onClearFilters && (
                            <Button
                                size="xs"
                                variant="helper"
                                onClick={onClearFilters}>
                                Clear filters
                            </Button>
                        )}
                    </>
                ) : (
                    <p className="text-text-secondary text-sm">
                        No pull requests reviewed yet.
                    </p>
                )}
            </div>
        );
    }

    const items = virtualizer.getVirtualItems();

    return (
        <div
            ref={scrollRef}
            className="border-card-lv3/60 bg-card-lv1 min-h-0 flex-1 overflow-auto rounded-xl border">
            {/* Below 40rem the grid scrolls sideways inside this container
                instead of crushing the title column. */}
            <div className="min-w-[40rem]">
                {/* Sticky table header — labels the aligned columns each row lays
                out via PR_ROW_GRID, so the signals (reviews / suggestions /
                status) read as a table while each row keeps its card richness
                and expandable timeline. */}
                <div
                    className={cn(
                        PR_ROW_GRID,
                        "border-card-lv3/40 bg-card-lv1/95 text-text-secondary text-2xs sticky top-0 z-10 border-b px-5 py-2.5 font-medium tracking-wide uppercase backdrop-blur",
                    )}>
                    {/* Column explanations. side="bottom" opens into the list (the
                    header sits at the top of the scroll container); the shared
                    TooltipContent portals to <body> so it never clips. */}
                    <span aria-hidden />
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="w-fit cursor-help">
                                Pull request
                            </span>
                        </TooltipTrigger>
                        <TooltipContent
                            side="bottom"
                            className="text-xs normal-case">
                            The PR — number, title, repository, branch, author
                            and when it was opened.
                        </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="w-fit cursor-help">Reviews</span>
                        </TooltipTrigger>
                        <TooltipContent
                            side="bottom"
                            className="text-xs normal-case">
                            How many times Kody reviewed this PR and how
                            recently.
                        </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="w-fit cursor-help">
                                Suggestions
                            </span>
                        </TooltipTrigger>
                        <TooltipContent
                            side="bottom"
                            className="text-xs normal-case">
                            Two counts: delivered on the PR (check icon) vs held
                            back by your review configuration (filter icon).
                        </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="w-fit cursor-help">Status</span>
                        </TooltipTrigger>
                        <TooltipContent
                            side="bottom"
                            className="text-xs normal-case">
                            Status of the latest review execution.
                        </TooltipContent>
                    </Tooltip>
                </div>
                {/* Virtualized body — rows align to the header via PR_ROW_GRID. */}
                <div
                    style={{
                        height: `${virtualizer.getTotalSize()}px`,
                        position: "relative",
                    }}>
                    {items.map((virtualRow) => (
                        <div
                            key={virtualRow.key}
                            data-index={virtualRow.index}
                            ref={virtualizer.measureElement}
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${virtualRow.start}px)`,
                            }}>
                            <PrListItem group={data[virtualRow.index]} />
                        </div>
                    ))}
                </div>

                <div ref={loadMoreRef} className="h-1 w-full" aria-hidden />
                {isFetchingNextPage && (
                    <div className="flex justify-center py-4">
                        <Spinner className="size-5" />
                    </div>
                )}
                {/* The way out whenever auto-pull steps back: a failed page, or
                    a filter so selective that it spent its budget without
                    filling the window. */}
                {hasNextPage &&
                    !isFetchingNextPage &&
                    (fetchNextPageFailed || autoPullExhausted) && (
                        <div className="flex flex-col items-center gap-2 py-4">
                            {fetchNextPageFailed && (
                                <p className="text-text-secondary text-xs">
                                    Loading more pull requests failed.
                                </p>
                            )}
                            <Button
                                size="sm"
                                variant="helper"
                                onClick={loadMore}>
                                {fetchNextPageFailed
                                    ? "Try again"
                                    : "Load more"}
                            </Button>
                        </div>
                    )}
            </div>
        </div>
    );
};
