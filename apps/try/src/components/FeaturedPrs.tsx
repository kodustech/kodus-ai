"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
    listFeaturedReviews,
    type FeaturedReviewSummary,
} from "@/lib/api";

const FALLBACK = [
    {
        slug: null,
        repo: "sgl-project/sglang",
        n: 12668,
        title: "Implement tool_choice support for Responses API",
        tag: "Rust",
        bugs: 0,
    },
    {
        slug: null,
        repo: "openai/codex",
        n: 8961,
        title: "Refactor session handlers",
        tag: "TypeScript",
        bugs: 0,
    },
    {
        slug: null,
        repo: "microsoft/vscode",
        n: 240128,
        title: "Webview lifecycle fixes",
        tag: "TypeScript",
        bugs: 0,
    },
];

export function FeaturedPrs({ onPick }: { onPick: (url: string) => void }) {
    const [items, setItems] = useState<FeaturedReviewSummary[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        listFeaturedReviews()
            .then((rows) => {
                if (!cancelled) setItems(rows);
            })
            .catch(() => {
                // API down or empty — keep null so we render the fallback.
                if (!cancelled) setItems([]);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    // Real curated reviews available — render the rich cards that link
    // straight to the cached /r/<slug> page (instant, no review run).
    if (items && items.length > 0) {
        return (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {items.map((item, idx) => (
                    <Link
                        key={item.slug}
                        href={`/r/${encodeURIComponent(item.slug)}`}
                        className="group fade-up text-left rounded-lg border border-[var(--border)] bg-[var(--bg-2)]/60 hover:bg-[var(--bg-3)] hover:border-[var(--border-strong)] transition-all px-3.5 py-3"
                        style={{ animationDelay: `${0.05 * (idx + 1)}s` }}
                    >
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-mono truncate">
                                {item.tags[0] ?? "code"}
                            </span>
                            <div className="flex items-center gap-1.5 shrink-0">
                                {item.issuesCount > 0 && (
                                    <span className="text-[10px] font-semibold px-1.5 py-px rounded bg-[var(--accent)]/15 text-[var(--accent)]">
                                        {item.issuesCount} bug
                                        {item.issuesCount === 1 ? "" : "s"}
                                    </span>
                                )}
                                <span className="text-[11px] font-mono text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors">
                                    #{item.pr.prNumber}
                                </span>
                            </div>
                        </div>
                        <p className="text-[13px] font-mono text-[var(--text-muted)] mb-1 truncate">
                            {item.pr.owner}/{item.pr.repo}
                        </p>
                        <p className="text-sm text-[var(--text)] leading-snug line-clamp-2">
                            {item.highlight ?? item.pr.title}
                        </p>
                    </Link>
                ))}
            </div>
        );
    }

    // Fallback: hit-or-miss list pointing at upstream PRs. Used while
    // the curator hasn't promoted anything yet, or if the API call
    // fails. Picking these still triggers a real review.
    return (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
            {FALLBACK.map((pr, idx) => (
                <button
                    key={pr.repo + pr.n}
                    onClick={() =>
                        onPick(`https://github.com/${pr.repo}/pull/${pr.n}`)
                    }
                    className="group fade-up text-left rounded-lg border border-[var(--border)] bg-[var(--bg-2)]/60 hover:bg-[var(--bg-3)] hover:border-[var(--border-strong)] transition-all px-3.5 py-3"
                    style={{ animationDelay: `${0.05 * (idx + 1)}s` }}
                >
                    <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[10px] uppercase tracking-wider text-[var(--text-dim)] font-mono">
                            {pr.tag}
                        </span>
                        <span className="text-[11px] font-mono text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors">
                            #{pr.n}
                        </span>
                    </div>
                    <p className="text-[13px] font-mono text-[var(--text-muted)] mb-1 truncate">
                        {pr.repo}
                    </p>
                    <p className="text-sm text-[var(--text)] leading-snug line-clamp-2">
                        {pr.title}
                    </p>
                </button>
            ))}
        </div>
    );
}
