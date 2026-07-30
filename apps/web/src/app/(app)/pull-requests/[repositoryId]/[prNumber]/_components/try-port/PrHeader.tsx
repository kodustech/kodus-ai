"use client";

import { useState } from "react";
import type { PrInfo } from "./types";

export type PrTab = "description" | "review" | "discussion" | "commits";

export function PrHeader({
    pr,
    suggestionCount,
    activeTab,
    onTabChange,
    toolbar,
    tabs,
}: {
    pr: PrInfo;
    suggestionCount: number;
    activeTab: PrTab;
    onTabChange: (tab: PrTab) => void;
    /** Right-side slot on the tab bar — view settings, file-tree toggle,
     *  any other control that acts on the diff content live here. */
    toolbar?: React.ReactNode;
    /** Which tabs to render. Defaults to all four (try parity); the web
     *  app only has data for some, so it passes a narrower list. */
    tabs?: PrTab[];
}) {
    return (
        <header className="mb-6 fade-up">
            <div className="flex items-center gap-2 mb-3">
                <StateBadge
                    state={pr.state}
                    merged={pr.merged}
                    isDraft={pr.isDraft}
                />
                <span className="text-[13px] font-mono text-[var(--text-muted)]">
                    {pr.owner}/{pr.repo} #{pr.prNumber}
                </span>
            </div>

            <h1 className="text-[26px] sm:text-[30px] leading-[1.15] tracking-tight font-medium text-[var(--text)] mb-4 max-w-4xl">
                {pr.title}
            </h1>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-[var(--text-muted)]">
                {pr.author && (
                    <a
                        href={pr.author.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 hover:text-[var(--text)] transition-colors"
                    >
                        {pr.author.avatarUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={pr.author.avatarUrl}
                                alt=""
                                width={20}
                                height={20}
                                className="rounded-full"
                            />
                        )}
                        <span className="text-[var(--text)] font-medium">
                            {pr.author.login}
                        </span>
                    </a>
                )}

                {pr.baseRef && pr.headRef && (
                    <span className="inline-flex items-center gap-1.5 font-mono text-[12px]">
                        <BranchPill>{pr.baseRef}</BranchPill>
                        <Arrow />
                        <BranchPill>{pr.headRef}</BranchPill>
                    </span>
                )}

                {pr.headSha && <CopyShaButton sha={pr.headSha} />}

                <span className="inline-flex items-center gap-1.5">
                    <span className="text-[var(--text-dim)]">
                        {pr.changedFiles} file
                        {pr.changedFiles === 1 ? "" : "s"}
                    </span>
                    <span className="font-mono">
                        <span className="text-[var(--green)]">
                            +{pr.additions}
                        </span>{" "}
                        <span className="text-[var(--red)]">
                            −{pr.deletions}
                        </span>
                    </span>
                </span>

                <a
                    href={pr.htmlUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-[12px] text-[var(--text-dim)] hover:text-[var(--text-muted)] inline-flex items-center gap-1"
                >
                    Open on GitHub <span aria-hidden>↗</span>
                </a>
            </div>

            <Tabs
                pr={pr}
                suggestionCount={suggestionCount}
                activeTab={activeTab}
                onTabChange={onTabChange}
                toolbar={toolbar}
                show={tabs}
            />
        </header>
    );
}

function Tabs({
    pr,
    suggestionCount,
    activeTab,
    onTabChange,
    toolbar,
    show,
}: {
    pr: PrInfo;
    suggestionCount: number;
    activeTab: PrTab;
    onTabChange: (tab: PrTab) => void;
    toolbar?: React.ReactNode;
    show?: PrTab[];
}) {
    const allTabs: { id: PrTab; label: string; count?: number }[] = [
        { id: "description", label: "Description" },
        { id: "review", label: "Review", count: suggestionCount },
        { id: "discussion", label: "Discussion", count: pr.discussionCount },
        { id: "commits", label: "Commits", count: pr.commitsCount },
    ];
    const tabs = show
        ? allTabs.filter((t) => show.includes(t.id))
        : allTabs;
    return (
        // Single hairline at the bottom of the nav: tabs sit on top
        // with their own 2px indicator. `-mb-px` on each button used
        // to align with the nav's border but rendered as two stacked
        // lines on some viewports — cleaner to draw the baseline once
        // here and let the active indicator overlap via box-shadow.
        <nav
            className="mt-5 flex items-center gap-1 relative"
            style={{ boxShadow: "inset 0 -1px 0 0 rgba(255,255,255,0.06)" }}
        >
            {tabs.map((tab) => {
                const active = activeTab === tab.id;
                return (
                    <button
                        key={tab.id}
                        onClick={() => onTabChange(tab.id)}
                        className={`relative cursor-pointer px-3 pb-2.5 pt-1 text-[13px] inline-flex items-center gap-1.5 rounded-t transition-colors ${
                            active
                                ? "text-[var(--text)] font-medium"
                                : "text-[var(--text)] hover:bg-[var(--bg-3)]/40"
                        }`}
                        style={
                            active
                                ? {
                                      boxShadow:
                                          "inset 0 -2px 0 0 var(--accent)",
                                  }
                                : undefined
                        }
                    >
                        {tab.label}
                        {tab.count !== undefined && tab.count > 0 && (
                            <span
                                className={`text-[10px] font-mono px-1.5 py-0.5 rounded transition-colors ${
                                    active
                                        ? "bg-[var(--accent)]/15 text-[var(--accent)]"
                                        : "bg-[var(--bg-3)] text-[var(--text-muted)]"
                                }`}
                            >
                                {tab.count}
                            </span>
                        )}
                    </button>
                );
            })}
            {toolbar && (
                <div className="ml-auto pb-1.5 flex items-center gap-1.5">
                    {toolbar}
                </div>
            )}
        </nav>
    );
}

function StateBadge({
    state,
    merged,
    isDraft,
}: {
    state?: "open" | "closed";
    merged?: boolean;
    isDraft?: boolean;
}) {
    let label = "Open";
    let cls =
        "bg-[var(--green)]/10 text-[var(--green)] border-[var(--green)]/30";
    let Icon = PullRequestIcon;

    if (merged) {
        label = "Merged";
        cls =
            "bg-[var(--secondary)]/10 text-[var(--secondary)] border-[var(--secondary)]/30";
        Icon = MergedIcon;
    } else if (state === "closed") {
        label = "Closed";
        cls = "bg-[var(--red)]/10 text-[var(--red)] border-[var(--red)]/30";
    } else if (isDraft) {
        label = "Draft";
        cls =
            "bg-[var(--bg-3)] text-[var(--text-muted)] border-[var(--border-strong)]";
    }

    return (
        <span
            className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full border ${cls}`}
        >
            <Icon />
            {label}
        </span>
    );
}

function CopyShaButton({ sha }: { sha: string }) {
    const [copied, setCopied] = useState(false);
    const short = sha.slice(0, 7);
    const onClick = async () => {
        try {
            await navigator.clipboard.writeText(sha);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* ignore */
        }
    };
    return (
        <button
            onClick={onClick}
            className="inline-flex items-center gap-1.5 font-mono text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
            title="Copy commit SHA"
        >
            <span className="px-1.5 py-0.5 rounded bg-[var(--bg-3)] border border-[var(--border)]">
                {short}
            </span>
            {copied ? <CheckMini /> : <CopyMini />}
        </button>
    );
}

function BranchPill({ children }: { children: React.ReactNode }) {
    return (
        <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--bg-3)] border border-[var(--border)] text-[var(--text-muted)]">
            {children}
        </span>
    );
}

function Arrow() {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[var(--text-dim)]"
            aria-hidden
        >
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 19" />
        </svg>
    );
}

function PullRequestIcon() {
    return (
        <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden
        >
            <path d="M1.5 3.25a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM5.677 14.04a.751.751 0 11-1.354.671.751.751 0 011.354-.671zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-.001 9.5a.75.75 0 100 1.5.75.75 0 000-1.5zM8.75 1.75A1.75 1.75 0 0110.5 0h3a1.75 1.75 0 011.75 1.75v7.736A2.251 2.251 0 0114 13.75a2.25 2.25 0 01-1.25-4.114V1.75a.25.25 0 00-.25-.25h-3a.25.25 0 00-.25.25v3.5h.586a.25.25 0 01.177.427L8.604 7.823a.25.25 0 01-.354 0L6.836 6.354a.25.25 0 01.177-.427H7.6V1.75z" />
        </svg>
    );
}

function MergedIcon() {
    return (
        <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden
        >
            <path d="M5 3.254V3.25v.005a.75.75 0 110-.005v.004zm.45 1.9a2.25 2.25 0 10-1.95.218v5.256a2.25 2.25 0 101.5 0V7.123A5.735 5.735 0 009.25 9h1.378a2.251 2.251 0 100-1.5H9.25a4.25 4.25 0 01-3.8-2.346zM12.75 9a.75.75 0 100-1.5.75.75 0 000 1.5zm-8.5 4.5a.75.75 0 100-1.5.75.75 0 000 1.5z" />
        </svg>
    );
}

function CopyMini() {
    return (
        <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
        >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
    );
}

function CheckMini() {
    return (
        <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-[var(--green)]"
            aria-hidden
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}
