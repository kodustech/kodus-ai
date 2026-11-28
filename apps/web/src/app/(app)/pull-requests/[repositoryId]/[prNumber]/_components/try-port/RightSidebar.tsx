"use client";

import { useState } from "react";
import {
    getSeverityColorVar,
    normalizeSeverity,
} from "@components/system/issue-severity-level-badge";
import type { SeverityLevel } from "src/core/types";

import type { PrInfo, ReviewIssue } from "./types";

// Explicit tier groups so the implicit "bugs vs flags" sort becomes visible,
// scannable headers. Ordered most-severe first; empty tiers don't render.
const TIERS: { key: SeverityLevel; label: string }[] = [
    { key: "critical" as SeverityLevel, label: "Critical" },
    { key: "high" as SeverityLevel, label: "High" },
    { key: "medium" as SeverityLevel, label: "Medium" },
    { key: "low" as SeverityLevel, label: "Low" },
];

export function RightSidebar({
    pr,
    issues,
    isCompleted,
    onJumpToIssue,
    activeIssueId,
    top,
}: {
    /** Cards above the findings (the Kody Runtime card). */
    top?: React.ReactNode;
    pr?: PrInfo;
    issues: ReviewIssue[];
    isCompleted: boolean;
    onJumpToIssue: (issue: ReviewIssue) => void;
    /** Id of the finding whose inline card is open/active — the matching rail
     *  row shows a persistent selected state. */
    activeIssueId?: string | null;
}) {
    const groups = TIERS.map((tier) => ({
        ...tier,
        items: issues.filter((i) => normalizeSeverity(i.severity) === tier.key),
    })).filter((g) => g.items.length > 0);

    const hasFindings = groups.length > 0;

    return (
        <aside className="space-y-3">
            {top}
            {isCompleted &&
                groups.map((group) => (
                    <SeverityGroup
                        key={group.key}
                        label={group.label}
                        color={getSeverityColorVar(group.key)}
                        items={group.items}
                        activeIssueId={activeIssueId}
                        onJumpToIssue={onJumpToIssue}
                    />
                ))}

            {pr?.checks && <ChecksCard checks={pr.checks} />}

            {pr?.reviewers && pr.reviewers.length > 0 && (
                <ReviewersCard reviewers={pr.reviewers} />
            )}

            {pr?.assignees && pr.assignees.length > 0 && (
                <AssigneesCard assignees={pr.assignees} />
            )}

            {pr?.labels && pr.labels.length > 0 && (
                <LabelsCard labels={pr.labels} />
            )}

            {isCompleted && !hasFindings && (
                <section
                    className="rounded-xl border border-[var(--green)]/25 bg-[var(--green)]/[0.05] px-3.5 py-4 text-center"
                    style={{ boxShadow: "var(--shadow-card)" }}>
                    <p className="text-review font-medium text-[var(--green)]">
                        Nothing to flag.
                    </p>
                </section>
            )}
        </aside>
    );
}

function SeverityGroup({
    label,
    color,
    items,
    activeIssueId,
    onJumpToIssue,
}: {
    label: string;
    color: string;
    items: ReviewIssue[];
    activeIssueId?: string | null;
    onJumpToIssue: (issue: ReviewIssue) => void;
}) {
    // Expanded by default (fix 7) — collapsing is a nicety.
    const [open, setOpen] = useState(true);
    return (
        <section
            className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-2)]/70 backdrop-blur-sm"
            style={{ boxShadow: "var(--shadow-card)" }}>
            <button
                onClick={() => setOpen((v) => !v)}
                className="flex w-full items-center justify-between px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--bg-3)]/40">
                <span className="flex items-center gap-2">
                    <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: color }}
                    />
                    <span className="text-3xs font-semibold tracking-[0.14em] text-[var(--text-dim)] uppercase">
                        {label}
                    </span>
                    <span className="text-3xs rounded bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[var(--text-muted)]">
                        {items.length}
                    </span>
                </span>
                <Chevron open={open} />
            </button>
            {open && (
                <ul className="divide-y divide-[var(--border)]/50">
                    {items.map((issue, i) => (
                        <IssueRow
                            key={issue.id ?? i}
                            issue={issue}
                            active={
                                !!activeIssueId && issue.id === activeIssueId
                            }
                            onClick={() => onJumpToIssue(issue)}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}

function AssigneesCard({
    assignees,
}: {
    assignees: NonNullable<PrInfo["assignees"]>;
}) {
    return (
        <SidebarCard title={`Assignees ${assignees.length}`}>
            <ul className="py-1.5">
                {assignees.map((a) => (
                    <li
                        key={a.login}
                        className="flex items-center gap-2.5 px-3.5 py-1.5 text-sm">
                        <Avatar src={a.avatarUrl} alt="" />
                        <a
                            href={a.htmlUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 truncate text-[var(--text)] transition-colors hover:text-[var(--accent)]">
                            {a.login}
                        </a>
                    </li>
                ))}
            </ul>
        </SidebarCard>
    );
}

function LabelsCard({ labels }: { labels: NonNullable<PrInfo["labels"]> }) {
    return (
        <SidebarCard title={`Labels ${labels.length}`}>
            <div className="flex flex-wrap gap-1.5 px-3 py-2.5">
                {labels.map((l) => (
                    <span
                        key={l.name}
                        title={l.description}
                        className="text-2xs inline-flex items-center rounded-full border px-2 py-0.5 font-medium"
                        style={{
                            // Use the GitHub label color as a tinted
                            // background + matching border. Text stays
                            // legible on dark by laying the hue at
                            // low opacity.
                            backgroundColor: l.color
                                ? `#${l.color}1a`
                                : "var(--bg-3)",
                            borderColor: l.color
                                ? `#${l.color}55`
                                : "var(--border)",
                            color: l.color ? `#${l.color}` : "var(--text)",
                        }}>
                        {l.name}
                    </span>
                ))}
            </div>
        </SidebarCard>
    );
}

function ChecksCard({ checks }: { checks: NonNullable<PrInfo["checks"]> }) {
    const tone =
        checks.conclusion === "success"
            ? "text-[var(--green)]"
            : checks.conclusion === "failure"
              ? "text-[var(--red)]"
              : checks.conclusion === "partial"
                ? "text-[var(--orange)]"
                : checks.conclusion === "pending"
                  ? "text-[var(--yellow)]"
                  : "text-[var(--text-muted)]";

    const label =
        checks.conclusion === "success"
            ? "Passing"
            : checks.conclusion === "failure"
              ? "Failing"
              : checks.conclusion === "partial"
                ? "Partial"
                : checks.conclusion === "pending"
                  ? "Pending"
                  : "Unknown";

    const verb =
        checks.conclusion === "failure" || checks.conclusion === "partial"
            ? `${checks.passed}/${checks.total}`
            : `${checks.total}`;

    return (
        <SidebarCard title="Checks">
            <div className="flex items-center justify-between px-3.5 py-3">
                <span className={`text-review font-medium ${tone}`}>
                    {label}
                </span>
                <span className="font-mono text-xs text-[var(--text-muted)]">
                    {verb}
                </span>
            </div>
        </SidebarCard>
    );
}

function ReviewersCard({
    reviewers,
}: {
    reviewers: NonNullable<PrInfo["reviewers"]>;
}) {
    return (
        <SidebarCard title={`Reviewers ${reviewers.length}`}>
            <ul className="py-1.5">
                {reviewers.map((r) => (
                    <li
                        key={r.login}
                        className="flex items-center gap-2.5 px-3.5 py-1.5 text-sm">
                        <Avatar src={r.avatarUrl} alt="" />
                        <span className="flex-1 truncate text-[var(--text)]">
                            {r.login}
                        </span>
                        <ReviewerStateIcon state={r.state} />
                    </li>
                ))}
            </ul>
        </SidebarCard>
    );
}

function ReviewerStateIcon({
    state,
}: {
    state: NonNullable<PrInfo["reviewers"]>[number]["state"];
}) {
    if (state === "approved") {
        return (
            <span
                title="Approved"
                className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--green)]/15 text-[var(--green)]">
                <CheckMini />
            </span>
        );
    }
    if (state === "changes_requested") {
        return (
            <span
                title="Changes requested"
                className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--red)]/15 text-[var(--red)]">
                <DotMini />
            </span>
        );
    }
    if (state === "pending") {
        return (
            <span
                title="Pending"
                className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--yellow)]/15 text-[var(--yellow)]">
                <ClockMini />
            </span>
        );
    }
    return (
        <span
            title="Commented"
            className="flex h-4 w-4 items-center justify-center rounded-full bg-[var(--bg-3)] text-[var(--text-muted)]">
            <CommentMini />
        </span>
    );
}

function IssueRow({
    issue,
    active = false,
    onClick,
}: {
    issue: ReviewIssue;
    /** The row whose inline card is currently open — held selected. */
    active?: boolean;
    onClick: () => void;
}) {
    const color = getSeverityColorVar(issue.severity);
    return (
        <li>
            <button
                onClick={onClick}
                aria-current={active ? "true" : undefined}
                // Real nav affordance: pointer + hover lift, plus a persistent
                // selected state (left accent bar in the tier colour + raised
                // bg) kept in sync with the open inline card.
                style={
                    active
                        ? { boxShadow: `inset 2px 0 0 0 ${color}` }
                        : undefined
                }
                className={`group w-full cursor-pointer px-3.5 py-2.5 text-left transition-colors ${
                    active
                        ? "bg-[var(--bg-input)]/60"
                        : "hover:bg-[var(--bg-input)]/40"
                }`}>
                <div className="mb-1 flex items-center gap-2">
                    <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: color }}
                    />
                    <span className="text-3xs font-semibold tracking-wider text-[var(--text-muted)] uppercase">
                        {issue.severity || "info"}
                    </span>
                    {issue.category && (
                        <span className="text-xs text-[var(--text-dim)]">
                            · {issue.category}
                        </span>
                    )}
                </div>
                <p
                    // A PR-level finding has no card in the diff to open, so
                    // selecting it unfolds its full text here instead.
                    className={`${
                        active && !issue.file
                            ? "whitespace-pre-wrap"
                            : "line-clamp-2"
                    } text-sm leading-snug transition-colors ${
                        active
                            ? "text-[var(--accent)]"
                            : "text-[var(--text)] group-hover:text-[var(--accent)]"
                    }`}>
                    {issue.message}
                </p>
                <p className="text-2xs mt-1 truncate font-mono text-[var(--text-dim)]">
                    {issue.file
                        ? `${basename(issue.file)}:${issue.line}`
                        : "PR-level comment"}
                </p>
            </button>
        </li>
    );
}

function SidebarCard({
    title,
    children,
    collapsible = false,
    open = true,
    onToggle,
}: {
    title: string;
    children?: React.ReactNode;
    collapsible?: boolean;
    open?: boolean;
    onToggle?: () => void;
}) {
    return (
        <section
            className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-2)]/70 backdrop-blur-sm"
            style={{ boxShadow: "var(--shadow-card)" }}>
            <header className="flex items-center justify-between border-b border-[var(--border)]/60 px-3.5 py-2.5">
                <p className="text-3xs font-semibold tracking-[0.14em] text-[var(--text-dim)] uppercase">
                    {title}
                </p>
                {collapsible && onToggle && (
                    <button
                        onClick={onToggle}
                        className="text-[var(--text-dim)] transition-colors hover:text-[var(--text-muted)]"
                        aria-label={open ? "Collapse" : "Expand"}>
                        <Chevron open={open} />
                    </button>
                )}
            </header>
            {children}
        </section>
    );
}

function Avatar({ src, alt }: { src?: string; alt: string }) {
    if (!src) {
        return (
            <span className="h-5 w-5 shrink-0 rounded-full border border-[var(--border)] bg-[var(--bg-3)]" />
        );
    }
    return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={src}
            alt={alt}
            width={20}
            height={20}
            className="shrink-0 rounded-full"
        />
    );
}

function Chevron({ open }: { open: boolean }) {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-[var(--text-dim)] transition-transform ${
                open ? "rotate-180" : ""
            }`}>
            <polyline points="6 9 12 15 18 9" />
        </svg>
    );
}

function CheckMini() {
    return (
        <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden>
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}

function DotMini() {
    return <span className="h-1 w-1 rounded-full bg-current" aria-hidden />;
}

function ClockMini() {
    return (
        <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15 14" />
        </svg>
    );
}

function CommentMini() {
    return (
        <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden>
            <path d="M3 4h18v12H5l-2 4z" />
        </svg>
    );
}

function basename(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? path : path.slice(idx + 1);
}
