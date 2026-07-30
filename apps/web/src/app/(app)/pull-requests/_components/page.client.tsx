"use client";

import { useMemo, useRef } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { useDebounce } from "@hooks/use-debounce";
import {
    useInfinitePullRequestExecutions,
    usePullRequestExecutionSSE,
    usePullRequestsDailyDigest,
    usePullRequestsFacets,
    type PullRequestExecution,
} from "@services/pull-requests";
import { SearchIcon, UserIcon, XIcon } from "lucide-react";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";

import { AwaitingList } from "./pr-awaiting-list";
import { PrAuthorSearch } from "./pr-author-search";
import { PrDataTable } from "./pr-data-table";
import { type PullRequestsScope } from "./pr-view-switcher";
import { PullRequestsFilters } from "./pull-requests-filters";

// Filters live in the URL (nuqs) so a filtered view is shareable / deep-linkable
// and survives reload — same pattern the Issues page uses. Writes are shallow
// with history:replace so typing doesn't spam the back button; the query itself
// stays debounced below.
const urlOpts = { shallow: true, history: "replace" } as const;
const SUGGESTIONS = ["all", "true", "false"] as const;
const AUTHOR_POLICIES = ["all", "reviewable", "excluded"] as const;
const STATUSES = [
    "success",
    "error",
    "partial_error",
    "skipped",
    "in_progress",
    "pending",
] as const;
// Mirrors the automation_execution status values verbatim.
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
    success: "Success",
    error: "Error",
    partial_error: "Partial error",
    skipped: "Skipped",
    in_progress: "In progress",
    pending: "Pending",
};
export function PullRequestsPageClient() {
    const { teamId } = useSelectedTeamId();
    usePullRequestExecutionSSE();
    const [selectedRepository, setSelectedRepository] = useQueryState(
        "repo",
        parseAsString.withOptions(urlOpts),
    );
    // Search box with an explicit Title|Number scope toggle inside it.
    const [searchQuery, setSearchQuery] = useQueryState(
        "q",
        parseAsString.withDefault("").withOptions(urlOpts),
    );
    const [searchMode, setSearchMode] = useQueryState(
        "by",
        parseAsStringLiteral(["title", "number", "author"] as const)
            .withDefault("title")
            .withOptions(urlOpts),
    );
    const [suggestionsFilter, setSuggestionsFilter] = useQueryState(
        "suggestions",
        parseAsStringLiteral(SUGGESTIONS)
            .withDefault("all")
            .withOptions(urlOpts),
    );
    const [authorPolicy, setAuthorPolicy] = useQueryState(
        "authors",
        parseAsStringLiteral(AUTHOR_POLICIES)
            .withDefault("reviewable")
            .withOptions(urlOpts),
    );
    const [statusFilter, setStatusFilter] = useQueryState(
        "status",
        parseAsStringLiteral(STATUSES).withOptions(urlOpts),
    );
    const [createdAtFrom, setCreatedAtFrom] = useQueryState(
        "from",
        parseAsString.withOptions(urlOpts),
    );
    const [createdAtTo, setCreatedAtTo] = useQueryState(
        "to",
        parseAsString.withOptions(urlOpts),
    );
    // Segment-tab params. needsAttention (crit/high) and author=me are dedicated;
    // the "errored" segment reuses statusFilter; "awaiting" is a distinct view.
    const [needsAttention, setNeedsAttention] = useQueryState(
        "needsAttention",
        parseAsString.withOptions(urlOpts),
    );
    const [authorFilter, setAuthorFilter] = useQueryState(
        "author",
        parseAsString.withOptions(urlOpts),
    );
    const [view, setView] = useQueryState(
        "view",
        parseAsStringLiteral(["awaiting"] as const).withOptions(urlOpts),
    );

    // View scope is temporarily PINNED to the team dashboard — the "My queue /
    // My team" switcher is hidden for now (product decision). The mine-view
    // machinery below (mine cards, author=me pin, scoped facets) is intentionally
    // left intact so re-enabling is just: restore the role default + `scope` URL
    // param here and render <PrViewSwitcher> in the header again.
    const scope: PullRequestsScope = "team";
    // Pinned off while the switcher is hidden; flip back to `scope === "mine"`
    // when the My queue view is re-enabled.
    const isMineView = false;

    const searchRef = useRef<HTMLInputElement>(null);

    const debouncedQuery = useDebounce(searchQuery, 400);
    // Author name search is debounced too — the URL updates per keystroke but
    // the (loop-filtered) request only fires once typing settles.
    const debouncedAuthor = useDebounce(authorFilter ?? "", 400);
    // "Minha fila" pins the list to my own PRs. `me` is a backend sentinel the
    // enriched use-case resolves to the logged-in user's git identity, so it
    // overrides any free-text author search while this view is active.
    // TODO(perf): author='me' is filtered post-query in the enriched use-case
    // (author lives in Mongo, not automation_execution), so pagination is
    // computed on the unfiltered team-wide batch. On a large team a
    // contributor's mine-view pages can under-fill and need extra round-trips.
    // Fix = resolve the caller's PR numbers first (needs a findNumbersByAuthor)
    // and scope the execution query before LIMIT/OFFSET. Deferred.
    const effectiveAuthor = isMineView
        ? "me"
        : debouncedAuthor.trim() || undefined;
    // "Minha fila" pins the author to me, so the author search scope makes no
    // sense there — offer only Title/Number, and if the URL still says
    // by=author, fall back to the plain search input.
    const searchModes = isMineView
        ? (["title", "number"] as const)
        : (["title", "number", "author"] as const);
    const showAuthorSearch = searchMode === "author" && !isMineView;

    // The scope toggle decides where the query is applied.
    const trimmedQuery = debouncedQuery.trim();
    const titleQuery = searchMode === "title" ? trimmedQuery : "";
    const numberQuery =
        searchMode === "number" ? trimmedQuery.replace(/^#/, "") : "";
    const hasSentSuggestionsParam =
        suggestionsFilter === "true"
            ? true
            : suggestionsFilter === "false"
              ? false
              : undefined;

    const {
        items: pullRequests,
        isLoading,
        error,
        hasNextPage,
        fetchNextPage,
        isFetchingNextPage,
        filteredPrTotal,
    } = useInfinitePullRequestExecutions(
        {
            teamId,
            repositoryName: selectedRepository ?? undefined,
            pullRequestTitle: titleQuery || undefined,
            pullRequestNumber: numberQuery || undefined,
            hasSentSuggestions: hasSentSuggestionsParam,
            authorPolicy,
            status: statusFilter ?? undefined,
            needsAttention: needsAttention === "true" ? true : undefined,
            author: effectiveAuthor,
            createdAtFrom: createdAtFrom ?? undefined,
            // Make the "to" bound inclusive of the whole selected day.
            createdAtTo: createdAtTo
                ? `${createdAtTo}T23:59:59.999`
                : undefined,
        },
        // This view mounts usePullRequestExecutionSSE (above), which invalidates
        // the query on every execution_updated event — so skip the redundant
        // 30s first-page poll.
        { pageSize: 30, poll: false },
    );

    const groupedPullRequests = useMemo(() => {
        const byPr = new Map<string, PullRequestExecution[]>();

        const getExecutionTime = (pr: PullRequestExecution) => {
            const value =
                pr.automationExecution?.createdAt ||
                pr.automationExecution?.updatedAt ||
                pr.updatedAt ||
                pr.createdAt;
            return value ? Date.parse(value) : 0;
        };

        pullRequests.forEach((pr) => {
            const existing = byPr.get(pr.prId) ?? [];
            existing.push(pr);
            byPr.set(pr.prId, existing);
        });

        const groups = Array.from(byPr.values()).map((executions) => {
            const sorted = [...executions].sort(
                (a, b) => getExecutionTime(b) - getExecutionTime(a),
            );
            const latest = sorted[0];

            return {
                prId: latest.prId,
                latest,
                executions: sorted,
                reviewCount: sorted.length,
            };
        });

        return groups.sort(
            (a, b) => getExecutionTime(b.latest) - getExecutionTime(a.latest),
        );
    }, [pullRequests]);

    const clearAllFilters = () => {
        setSelectedRepository(null);
        setSearchQuery("");
        setSuggestionsFilter("all");
        setAuthorPolicy("reviewable");
        setStatusFilter(null);
        setNeedsAttention(null);
        setAuthorFilter(null);
        setView(null);
        setCreatedAtFrom(null);
        setCreatedAtTo(null);
    };

    // "Awaiting review" is a distinct dataset (open PRs with no review), so it's
    // a toggle in the filter bar rather than a filter value. Its count comes
    // from the facets endpoint.
    const isAwaiting = view === "awaiting";
    // Facets follow the view: in "mine" the actionable count is scoped to my PRs
    // so the card can't overcount team work under a "mine" heading.
    const { data: facets } = usePullRequestsFacets(teamId, scope);
    // Daily "pulse of the review process" — how it's going today, not the state
    // of any single PR. Drives the summary strip below the header.
    const { data: digest } = usePullRequestsDailyDigest(teamId);

    // Surface the applied filters as removable chips (the popover only shows a
    // count). Defaults — suggestions "all", authors "reviewable" — are not chips.
    const suggestionsChipLabel = {
        true: "Has suggestions",
        false: "No suggestions",
    };
    const authorChipLabel = { all: "All authors", excluded: "Excluded only" };
    const activeChips = [
        selectedRepository && {
            key: "repo",
            label: `Repo: ${selectedRepository}`,
            clear: () => {
                setSelectedRepository(null);
            },
        },
        searchQuery.trim() && {
            key: "q",
            label:
                searchMode === "number"
                    ? `PR #${searchQuery.trim().replace(/^#/, "")}`
                    : `Title: "${searchQuery.trim()}"`,
            clear: () => {
                setSearchQuery("");
            },
        },
        // In "Minha fila" the list is pinned to author=me, so a leftover
        // free-text author filter is inert — don't surface it as a chip.
        !isMineView &&
            authorFilter?.trim() && {
                key: "author",
                label: `Author: ${authorFilter.trim()}`,
                clear: () => {
                    setAuthorFilter(null);
                },
            },
        suggestionsFilter !== "all" && {
            key: "suggestions",
            label: suggestionsChipLabel[suggestionsFilter],
            clear: () => {
                setSuggestionsFilter("all");
            },
        },
        authorPolicy !== "reviewable" && {
            key: "authors",
            label: authorChipLabel[authorPolicy],
            clear: () => {
                setAuthorPolicy("reviewable");
            },
        },
        statusFilter && {
            key: "status",
            label: `Status: ${STATUS_LABEL[statusFilter]}`,
            clear: () => {
                setStatusFilter(null);
            },
        },
        (createdAtFrom || createdAtTo) && {
            key: "date",
            label: `Date: ${createdAtFrom || "…"} → ${createdAtTo || "…"}`,
            clear: () => {
                setCreatedAtFrom(null);
                setCreatedAtTo(null);
            },
        },
    ].filter(
        (chip): chip is { key: string; label: string; clear: () => void } =>
            Boolean(chip),
    );

    // Header count. Three sources, most-accurate first:
    //   1. No filters → the unfiltered team facet (`facets.all`).
    //   2. Only DB-level filters (status/date/repo/number/title) → the backend's
    //      `filteredPrTotal` (distinct PRs matching those filters — exact).
    //   3. A Mongo-side filter is active (suggestions/needs-attention/author/
    //      author-policy) → the backend can't count those server-side yet, so
    //      fall back to the loaded window and mark it partial ("+").
    // `groupedPullRequests.length` alone only reflects the loaded page, so it
    // understated the real total (read "150 pull requests" next to "665
    // awaiting"); it's the last resort.
    // Any authorPolicy other than "all" narrows the visible set relative to the
    // team-wide `facets.all` (the default "reviewable" already excludes some
    // authors). Treat that as an active filter so the header stops showing the
    // team total and falls back to the loaded-window count — the number then
    // matches the list instead of overcounting.
    const hasActiveFilters =
        activeChips.length > 0 ||
        needsAttention === "true" ||
        isAwaiting ||
        isMineView ||
        authorPolicy !== "all";
    // Filters applied post-query (Mongo side) — while any is active,
    // `filteredPrTotal` (DB-level only) is an upper bound, not exact. The
    // "mine" view pins author=me, which is post-query too.
    const hasMongoFilters =
        suggestionsFilter !== "all" ||
        needsAttention === "true" ||
        !!effectiveAuthor ||
        authorPolicy !== "all";
    const canUseExactFilteredTotal =
        hasActiveFilters &&
        !isAwaiting &&
        !hasMongoFilters &&
        typeof filteredPrTotal === "number";
    const totalCount = !hasActiveFilters
        ? typeof facets?.all === "number"
            ? facets.all
            : groupedPullRequests.length
        : canUseExactFilteredTotal
          ? filteredPrTotal
          : groupedPullRequests.length;
    // Exact counts (facets.all, filteredPrTotal) are never partial; only the
    // loaded-window fallback gets the "+".
    const isPartialCount =
        hasActiveFilters && !canUseExactFilteredTotal && hasNextPage;

    // "Pulse of the review process" strip. Each card is a shortcut that filters
    // the list below to its segment (toggles off if already active). The number
    // is today's digest value; Awaiting/Needs-attention are current totals.
    //
    // The two "today" cards scope the list to today (UTC) so clicking them shows
    // exactly what they count — otherwise "Review failed today: 0" filtered by
    // status=error alone and surfaced every all-time error (confusing: a 0 card
    // opening a week-old list). Date-only YYYY-MM-DD matches the digest's UTC
    // day; the query widens the upper bound to end-of-day.
    const todayIso = new Date().toISOString().slice(0, 10);
    const isTodayScoped =
        createdAtFrom === todayIso && createdAtTo === todayIso;
    const reviewedTodayActive =
        !isAwaiting &&
        needsAttention !== "true" &&
        statusFilter === null &&
        isTodayScoped;
    // No separate "Review failed today" card: it's just "Reviewed today" + the
    // Status: Error filter, so it was redundant. Clicking "Reviewed today"
    // scopes the list to today; the user adds a Status filter to narrow to
    // failures (or any other status).
    const scopeToToday = () => {
        setView(null);
        setNeedsAttention(null);
        setStatusFilter(null);
        setCreatedAtFrom(todayIso);
        setCreatedAtTo(todayIso);
    };
    const clearTodayScope = () => {
        setStatusFilter(null);
        setCreatedAtFrom(null);
        setCreatedAtTo(null);
    };
    const toggleNeedsAttention = () => {
        setView(null);
        setStatusFilter(null);
        setNeedsAttention(
            !isAwaiting && needsAttention === "true" ? null : "true",
        );
    };
    // Team dashboard cards — the lead's "how are we doing?" across the whole
    // team scope. Depend on the daily digest (today's pulse).
    const teamPulseCards = digest
        ? [
              {
                  key: "reviewed",
                  label: "Reviewed today",
                  sub: "today",
                  hint: "Distinct PRs Kody reviewed today (UTC). Opens today's reviews — add a Status filter to narrow (e.g. failed).",
                  value: digest.reviewedToday,
                  tone: "text-success",
                  active: reviewedTodayActive,
                  onClick: () =>
                      reviewedTodayActive ? clearTodayScope() : scopeToToday(),
              },
              {
                  key: "awaiting",
                  label: "Awaiting review",
                  sub: "backlog",
                  hint: "PRs Kody was triggered on but skipped and never reviewed — blocked by config (no license, BYOK, manual/paused cadence, ignored user). Current backlog, not today.",
                  // Backlog is a current total, not a "today" number — read it
                  // from facets (same source as the toggle's 665), so the card
                  // and the toggle never disagree.
                  value: facets?.awaiting ?? 0,
                  tone: "text-text-primary",
                  active: isAwaiting,
                  onClick: () => {
                      setStatusFilter(null);
                      setNeedsAttention(null);
                      setView(isAwaiting ? null : "awaiting");
                  },
              },
              {
                  key: "attention",
                  label: "Needs attention",
                  sub: "total",
                  hint: "Open PRs where Kody delivered a suggestion the author still hasn't applied — your actionable backlog (Kody verifies whether each suggestion was implemented). Click to see exactly these PRs; may lag until the next verification pass.",
                  // Open PRs that still carry an unresolved delivered suggestion
                  // (implementationStatus ≠ implemented) — actionable, not
                  // "ever delivered a crit/high".
                  value: facets?.needsAttention ?? 0,
                  tone: "text-warning",
                  active: !isAwaiting && needsAttention === "true",
                  onClick: toggleNeedsAttention,
              },
          ]
        : [];
    // "Minha fila" cards — my worklist. Both numbers are author-scoped by the
    // facets endpoint (scope=mine), so they never show team totals under a
    // "mine" heading. The two cards are the two halves of the mine list: what
    // still needs me vs. everything I've had reviewed.
    const minePulseCards = facets
        ? [
              {
                  key: "mine-attention",
                  label: "Needs my attention",
                  sub: "open",
                  hint: "Your open PRs where Kody left a suggestion you haven't applied yet. Click to filter to just these.",
                  value: facets.needsAttention ?? 0,
                  tone: "text-warning",
                  active: needsAttention === "true",
                  onClick: toggleNeedsAttention,
              },
              {
                  key: "mine-reviewed",
                  label: "My reviewed PRs",
                  sub: "total",
                  hint: "All of your PRs Kody has already reviewed. Click to see the full queue.",
                  value: facets.mine ?? 0,
                  tone: "text-success",
                  active: needsAttention !== "true",
                  onClick: () => {
                      setStatusFilter(null);
                      setNeedsAttention(null);
                  },
              },
          ]
        : [];
    const pulseCards = isMineView ? minePulseCards : teamPulseCards;

    return (
        <Page.Root className="pb-0">
            <Page.Header className="max-w-full">
                <div className="flex w-full items-center justify-between">
                    <div className="flex items-center gap-4">
                        <Page.Title className="text-balance">
                            Pull Requests
                        </Page.Title>

                        {totalCount > 0 && (
                            <span className="text-text-tertiary text-sm tabular-nums">
                                {totalCount}
                                {isPartialCount ? "+" : ""} pull request
                                {totalCount > 1 ? "s" : ""}
                                {selectedRepository && (
                                    <>
                                        {" "}
                                        in{" "}
                                        <span className="text-text-secondary font-medium">
                                            {selectedRepository}
                                        </span>
                                    </>
                                )}
                            </span>
                        )}
                    </div>
                </div>
            </Page.Header>

            <Page.Content className="max-w-full px-6">
                {/* Pulse of the review process — the daily "how are we doing?"
                    that a lead wants before scanning individual PRs. Each card
                    filters the list to its segment. */}
                {pulseCards.length > 0 && (
                    <div
                        className={cn(
                            "grid grid-cols-1 gap-3 pt-4",
                            pulseCards.length === 2
                                ? "sm:grid-cols-2"
                                : "sm:grid-cols-3",
                        )}>
                        {pulseCards.map((card) => (
                            <button
                                key={card.key}
                                type="button"
                                onClick={card.onClick}
                                aria-pressed={card.active}
                                title={card.hint}
                                className={cn(
                                    "flex flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left transition",
                                    card.active
                                        ? "border-primary-light/60 bg-primary/5 ring-primary-light/15 ring-3"
                                        : "border-card-lv3 bg-card-lv2 hover:border-card-lv3 hover:bg-card-lv1/70",
                                )}>
                                <span className="flex w-full items-center justify-between gap-2">
                                    <span className="text-text-tertiary text-xs font-medium">
                                        {card.label}
                                    </span>
                                    {/* Scope tag — the cards mix "today" numbers
                                        (digest) with current totals (facets), so
                                        each one says which it is. */}
                                    <span className="text-text-tertiary/70 bg-card-lv3/40 rounded px-1.5 py-0.5 text-[0.625rem] font-medium tracking-wide uppercase">
                                        {card.sub}
                                    </span>
                                </span>
                                <span
                                    className={cn(
                                        "text-2xl font-semibold tabular-nums",
                                        card.tone,
                                    )}>
                                    {card.value}
                                </span>
                            </button>
                        ))}
                    </div>
                )}

                {/* Filter toolbar — two rows: free-text searches on top,
                    structured filters below, so neither row feels crammed. */}
                <div className="flex flex-col gap-2 py-4">
                    {/* Row 1 — one search box, three scopes: Title / Number /
                        Author. Title & Number drive the `q` query; Author drives
                        the author-name filter — so the user picks WHAT to search
                        instead of juggling two inputs. */}
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="border-card-lv3 bg-card-lv2 focus-within:border-primary-light/50 focus-within:ring-primary-light/15 flex h-9 min-w-[18rem] flex-1 items-center gap-2 rounded-xl border pr-1.5 pl-3 transition focus-within:ring-3">
                            {showAuthorSearch ? (
                                <UserIcon className="text-text-tertiary size-4 shrink-0" />
                            ) : (
                                <SearchIcon className="text-text-tertiary size-4 shrink-0" />
                            )}
                            {showAuthorSearch ? (
                                <PrAuthorSearch
                                    teamId={teamId}
                                    onSelect={(name) =>
                                        setAuthorFilter(name || null)
                                    }
                                />
                            ) : (
                                <input
                                    ref={searchRef}
                                    className="text-text-primary placeholder:text-text-tertiary/70 h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
                                    inputMode={
                                        searchMode === "number"
                                            ? "numeric"
                                            : "text"
                                    }
                                    placeholder={
                                        searchMode === "number"
                                            ? "Search by PR number…"
                                            : "Search by title…"
                                    }
                                    value={searchQuery}
                                    onChange={(event) => {
                                        setSearchQuery(
                                            searchMode === "number"
                                                ? event.target.value.replace(
                                                      /[^\d]/g,
                                                      "",
                                                  )
                                                : event.target.value,
                                        );
                                    }}
                                />
                            )}
                            <div className="bg-card-lv1/80 flex shrink-0 items-center gap-0.5 rounded-lg p-0.5">
                                {searchModes.map(
                                    (mode) => (
                                        <button
                                            key={mode}
                                            type="button"
                                            onClick={() => {
                                                // Switching scope starts a fresh
                                                // search — clear both the text
                                                // query and the author filter.
                                                setSearchMode(mode);
                                                setSearchQuery("");
                                                setAuthorFilter(null);
                                            }}
                                            className={cn(
                                                "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition",
                                                searchMode === mode
                                                    ? "bg-card-lv3 text-text-primary"
                                                    : "text-text-tertiary hover:text-text-secondary",
                                            )}>
                                            {mode}
                                        </button>
                                    ),
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Row 2 — structured filters. */}
                    <div className="flex flex-wrap items-center gap-2">
                        <PullRequestsFilters
                            teamId={teamId}
                            selectedRepository={selectedRepository ?? undefined}
                            onRepositoryChange={(value) =>
                                setSelectedRepository(value ?? null)
                            }
                            suggestionsFilter={suggestionsFilter}
                            onSuggestionsFilterChange={(value) =>
                                setSuggestionsFilter(value)
                            }
                            authorPolicy={authorPolicy}
                            onAuthorPolicyChange={(value) =>
                                setAuthorPolicy(value)
                            }
                            createdAtFrom={createdAtFrom}
                            createdAtTo={createdAtTo}
                            onCreatedAtFromChange={(value) =>
                                setCreatedAtFrom(value || null)
                            }
                            onCreatedAtToChange={(value) =>
                                setCreatedAtTo(value || null)
                            }
                        />

                        <Select
                            value={statusFilter ?? "all"}
                            onValueChange={(value) =>
                                setStatusFilter(
                                    value === "all"
                                        ? null
                                        : (value as (typeof STATUSES)[number]),
                                )
                            }>
                            <SelectTrigger
                                size="sm"
                                className={cn(
                                    "h-9 w-auto gap-1.5 rounded-lg",
                                    statusFilter && "border-primary-light/50",
                                )}>
                                <SelectValue placeholder="Status" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">Any status</SelectItem>
                                {STATUSES.map((s) => (
                                    <SelectItem key={s} value={s}>
                                        {STATUS_LABEL[s]}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                {activeChips.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 pb-4">
                        {activeChips.map((chip) => (
                            <Button
                                key={chip.key}
                                size="xs"
                                variant="helper"
                                rightIcon={<XIcon />}
                                onClick={chip.clear}>
                                {chip.label}
                            </Button>
                        ))}
                        <Button
                            size="xs"
                            variant="cancel"
                            onClick={clearAllFilters}>
                            Clear all
                        </Button>
                    </div>
                )}

                {isAwaiting ? (
                    <AwaitingList teamId={teamId} />
                ) : error ? (
                    <div className="py-12 text-center">
                        <p className="text-sm text-red-600">
                            Error loading pull requests. Please try again.
                        </p>
                    </div>
                ) : (
                    <PrDataTable
                        data={groupedPullRequests}
                        loading={isLoading && !groupedPullRequests.length}
                        hasNextPage={hasNextPage}
                        isFetchingNextPage={isFetchingNextPage}
                        fetchNextPage={fetchNextPage}
                        hasActiveFilters={activeChips.length > 0}
                        onClearFilters={clearAllFilters}
                    />
                )}
            </Page.Content>
        </Page.Root>
    );
}
