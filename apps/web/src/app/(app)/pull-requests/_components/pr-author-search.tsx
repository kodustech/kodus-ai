"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
    usePullRequestAuthors,
    type PullRequestAuthorOption,
} from "@services/pull-requests";
import { cn } from "src/core/utils/components";

interface PrAuthorSearchProps {
    teamId?: string;
    // Called with the author's EXACT display name — the list then filters to
    // that identity precisely. Typing is kept local so the list isn't filtered
    // mid-search; only a selection applies.
    onSelect: (name: string) => void;
    placeholder?: string;
}

// Cap how many options render at once — the full list is client-side filtered,
// but a giant dropdown is neither useful nor fast to paint.
const MAX_VISIBLE = 50;

export function PrAuthorSearch({
    teamId,
    onSelect,
    placeholder,
}: PrAuthorSearchProps) {
    const [query, setQuery] = useState("");
    const [open, setOpen] = useState(false);
    const [highlight, setHighlight] = useState(0);
    const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const activeOptionRef = useRef<HTMLButtonElement>(null);

    const clearBlurTimer = () => {
        if (blurTimer.current) {
            clearTimeout(blurTimer.current);
            blurTimer.current = null;
        }
    };

    // Cancel a pending close on unmount so the delayed setOpen(false) can't fire
    // after teardown (and a quick refocus can't be closed by a stale timer).
    useEffect(() => clearBlurTimer, []);

    // Keep the keyboard-highlighted option scrolled into the (max-h-64) list.
    useEffect(() => {
        activeOptionRef.current?.scrollIntoView({ block: "nearest" });
    }, [highlight]);

    // Loads the full (server-cached) author list once and filters in memory —
    // no backend round-trip per keystroke. Only fetched once the field opens.
    const { data: authors = [], isLoading } = usePullRequestAuthors(
        teamId,
        open,
    );

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = q
            ? authors.filter(
                  (a: PullRequestAuthorOption) =>
                      a.name.toLowerCase().includes(q) ||
                      a.username.toLowerCase().includes(q),
              )
            : authors;
        return list.slice(0, MAX_VISIBLE);
    }, [authors, query]);

    const pick = (author: PullRequestAuthorOption) => {
        onSelect(author.name);
        setQuery("");
        setOpen(false);
    };

    return (
        <div className="relative flex h-full min-w-0 flex-1">
            <input
                className="text-text-primary placeholder:text-text-tertiary/70 h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
                placeholder={placeholder ?? "Search by author…"}
                value={query}
                onChange={(event) => {
                    setQuery(event.target.value);
                    setOpen(true);
                    setHighlight(0);
                }}
                onFocus={() => {
                    clearBlurTimer();
                    setOpen(true);
                }}
                onBlur={() => {
                    // Delay so a click on an option registers before closing.
                    clearBlurTimer();
                    blurTimer.current = setTimeout(() => setOpen(false), 120);
                }}
                onKeyDown={(event) => {
                    if (!open) return;
                    // Escape must close the dropdown even when it shows no
                    // matches — so handle it before the empty-list guard.
                    if (event.key === "Escape") {
                        setOpen(false);
                        return;
                    }
                    if (filtered.length === 0) return;
                    if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setHighlight((h) =>
                            Math.min(h + 1, filtered.length - 1),
                        );
                    } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setHighlight((h) => Math.max(h - 1, 0));
                    } else if (event.key === "Enter") {
                        event.preventDefault();
                        const author = filtered[highlight];
                        if (author) pick(author);
                    }
                }}
            />
            {open && (
                <div className="border-card-lv3 bg-card-lv2 absolute top-[calc(100%+0.5rem)] right-0 left-0 z-50 max-h-64 overflow-y-auto rounded-xl border py-1 shadow-lg">
                    {isLoading && authors.length === 0 ? (
                        <div className="text-text-tertiary px-3 py-2 text-xs">
                            Loading authors…
                        </div>
                    ) : filtered.length === 0 ? (
                        <div className="text-text-tertiary px-3 py-2 text-xs">
                            {query.trim()
                                ? "No authors match."
                                : "No authors yet."}
                        </div>
                    ) : (
                        filtered.map((author: PullRequestAuthorOption, index: number) => (
                            <button
                                key={`${author.username ?? ""}:${author.name ?? ""}:${index}`}
                                ref={
                                    index === highlight ? activeOptionRef : null
                                }
                                type="button"
                                // Prevent the input blur from firing before the
                                // click, which would close the dropdown first.
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() => pick(author)}
                                onMouseEnter={() => setHighlight(index)}
                                className={cn(
                                    "flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors",
                                    index === highlight
                                        ? "bg-card-lv3 text-text-primary"
                                        : "text-text-secondary hover:bg-card-lv3/60",
                                )}>
                                <span className="min-w-0 truncate">
                                    <span className="font-medium">
                                        {author.name}
                                    </span>
                                    {author.username && (
                                        <span className="text-text-tertiary">
                                            {" "}
                                            @{author.username}
                                        </span>
                                    )}
                                </span>
                                <span className="text-text-tertiary shrink-0 text-xs tabular-nums">
                                    {author.count}
                                </span>
                            </button>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
