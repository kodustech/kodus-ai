"use client";

import { useState } from "react";
import type { PrInfo, ReviewIssue } from "@/lib/api";
import { useSignupGate } from "./SignupGate";

const KODY_AVATAR_URL = "https://avatars.githubusercontent.com/in/413034?v=4";

/**
 * The model the public-demo runs on. Kept in sync with
 * agent-review.stage.ts `defaultModelOverride`. Hardcoded here because
 * the server doesn't echo it back — if we ever switch the trial model
 * (e.g. via env var), update both spots.
 */
const REVIEW_MODEL = {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash",
};

const SEVERITY_DOT: Record<string, string> = {
    critical: "bg-[var(--red)]",
    high: "bg-[var(--red)]",
    medium: "bg-[var(--yellow)]",
    low: "bg-[var(--accent)]",
    info: "bg-[var(--text-dim)]",
};

export function RightSidebar({
    pr,
    issues,
    isCompleted,
    onJumpToIssue,
}: {
    pr?: PrInfo;
    issues: ReviewIssue[];
    isCompleted: boolean;
    onJumpToIssue: (file: string) => void;
}) {
    const bugs = issues.filter((i) =>
        ["critical", "high"].includes((i.severity || "").toLowerCase()),
    );
    const flags = issues.filter(
        (i) => !["critical", "high"].includes((i.severity || "").toLowerCase()),
    );

    return (
        <aside className="space-y-3">
            {isCompleted && bugs.length > 0 && (
                <BugsCard bugs={bugs} onJumpToIssue={onJumpToIssue} />
            )}

            {isCompleted && flags.length > 0 && (
                <FlagsCard flags={flags} onJumpToIssue={onJumpToIssue} />
            )}

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

            {/* Upgrade CTA at the bottom so it reads as "signature"
                rather than the first thing screaming for attention. */}
            <ReviewModelCard />
        </aside>
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
                        className="px-3.5 py-1.5 flex items-center gap-2.5 text-sm"
                    >
                        <Avatar src={a.avatarUrl} alt="" />
                        <a
                            href={a.htmlUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 truncate text-[var(--text)] hover:text-[var(--accent)] transition-colors"
                        >
                            {a.login}
                        </a>
                    </li>
                ))}
            </ul>
        </SidebarCard>
    );
}

function LabelsCard({
    labels,
}: {
    labels: NonNullable<PrInfo["labels"]>;
}) {
    return (
        <SidebarCard title={`Labels ${labels.length}`}>
            <div className="px-3 py-2.5 flex flex-wrap gap-1.5">
                {labels.map((l) => (
                    <span
                        key={l.name}
                        title={l.description}
                        className="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border"
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
                            color: l.color
                                ? `#${l.color}`
                                : "var(--text)",
                        }}
                    >
                        {l.name}
                    </span>
                ))}
            </div>
        </SidebarCard>
    );
}

function ReviewModelCard() {
    const { open } = useSignupGate();
    const upgradeTo = [
        "Claude Opus 4.7",
        "GPT-5",
        "Gemini 3 Pro",
        "Your own model (BYOK)",
    ];

    const trigger = () =>
        open({
            title: "Run reviews on your favorite model",
            body: "The free demo uses Gemini 3 Flash — fast and good enough to spot the obvious. Sign up to switch to Claude Opus 4.7, GPT-5, Gemini 3 Pro or plug your own provider key (BYOK).",
        });

    return (
        <section
            className="rounded-xl border border-[var(--border)] bg-gradient-to-br from-[var(--bg-2)] to-[var(--bg-3)]/60 overflow-hidden relative"
            style={{ boxShadow: "var(--shadow-card)" }}
        >
            <div
                aria-hidden
                className="absolute -top-12 -right-12 w-32 h-32 rounded-full bg-[var(--accent)]/10 blur-2xl pointer-events-none"
            />
            <header className="relative px-3.5 py-2.5 border-b border-[var(--border)]/60 flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-[0.14em] font-semibold text-[var(--text-dim)]">
                    Review model
                </p>
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--bg-3)] text-[var(--text-muted)] border border-[var(--border)]">
                    free demo
                </span>
            </header>

            <div className="relative px-3.5 py-3">
                <div className="flex items-center gap-2 mb-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={KODY_AVATAR_URL}
                        alt=""
                        width={20}
                        height={20}
                        className="rounded-full ring-1 ring-[var(--border)]"
                    />
                    <div className="min-w-0">
                        <p className="text-sm text-[var(--text)] font-medium truncate">
                            Kody, on {REVIEW_MODEL.label}
                        </p>
                        <p className="text-[11px] font-mono text-[var(--text-dim)] truncate">
                            {REVIEW_MODEL.id}
                        </p>
                    </div>
                </div>

                <p className="text-[12px] text-[var(--text-muted)] leading-relaxed mb-3">
                    Want sharper reviews? Run Kody on:
                </p>
                <ul className="space-y-1 mb-4">
                    {upgradeTo.map((m) => (
                        <li
                            key={m}
                            className="flex items-center gap-1.5 text-[12.5px] text-[var(--text)]"
                        >
                            <span className="text-[var(--accent)]">›</span>
                            {m}
                        </li>
                    ))}
                </ul>

                <button
                    type="button"
                    onClick={trigger}
                    className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] px-3 py-2 rounded-md transition-colors"
                    style={{
                        boxShadow:
                            "0 0 0 1px rgba(248,183,109,0.4), 0 6px 18px -6px var(--accent-glow)",
                    }}
                >
                    Upgrade model
                    <span aria-hidden>→</span>
                </button>
            </div>
        </section>
    );
}

function BugsCard({
    bugs,
    onJumpToIssue,
}: {
    bugs: ReviewIssue[];
    onJumpToIssue: (file: string) => void;
}) {
    const [open, setOpen] = useState(true);
    return (
        <section
            className="rounded-xl border border-[var(--accent)]/25 bg-gradient-to-b from-[var(--accent)]/[0.05] to-transparent overflow-hidden"
            style={{ boxShadow: "var(--shadow-card)" }}
        >
            <button
                onClick={() => setOpen((v) => !v)}
                className="w-full px-3.5 py-3 flex items-center justify-between text-left hover:bg-[var(--accent)]/5 transition-colors"
            >
                <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--text)]">
                    <BugIcon />
                    {bugs.length} Potential bug{bugs.length === 1 ? "" : "s"}
                </span>
                <Chevron open={open} />
            </button>
            {open && (
                <ul className="divide-y divide-[var(--border)]/50">
                    {bugs.map((bug, i) => (
                        <IssueRow
                            key={i}
                            issue={bug}
                            onClick={() => onJumpToIssue(bug.file)}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}

function FlagsCard({
    flags,
    onJumpToIssue,
}: {
    flags: ReviewIssue[];
    onJumpToIssue: (file: string) => void;
}) {
    const [open, setOpen] = useState(false);
    return (
        <SidebarCard
            title={`${flags.length} Flag${flags.length === 1 ? "" : "s"}`}
            collapsible
            open={open}
            onToggle={() => setOpen((v) => !v)}
        >
            {open && (
                <ul className="divide-y divide-[var(--border)]/50">
                    {flags.map((flag, i) => (
                        <IssueRow
                            key={i}
                            issue={flag}
                            onClick={() => onJumpToIssue(flag.file)}
                        />
                    ))}
                </ul>
            )}
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
            <div className="px-3.5 py-3 flex items-center justify-between">
                <span className={`text-[13px] font-medium ${tone}`}>
                    {label}
                </span>
                <span className="text-xs font-mono text-[var(--text-muted)]">
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
                        className="px-3.5 py-1.5 flex items-center gap-2.5 text-sm"
                    >
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
                className="w-4 h-4 rounded-full bg-[var(--green)]/15 text-[var(--green)] flex items-center justify-center"
            >
                <CheckMini />
            </span>
        );
    }
    if (state === "changes_requested") {
        return (
            <span
                title="Changes requested"
                className="w-4 h-4 rounded-full bg-[var(--red)]/15 text-[var(--red)] flex items-center justify-center"
            >
                <DotMini />
            </span>
        );
    }
    if (state === "pending") {
        return (
            <span
                title="Pending"
                className="w-4 h-4 rounded-full bg-[var(--yellow)]/15 text-[var(--yellow)] flex items-center justify-center"
            >
                <ClockMini />
            </span>
        );
    }
    return (
        <span
            title="Commented"
            className="w-4 h-4 rounded-full bg-[var(--bg-3)] text-[var(--text-muted)] flex items-center justify-center"
        >
            <CommentMini />
        </span>
    );
}

function IssueRow({
    issue,
    onClick,
}: {
    issue: ReviewIssue;
    onClick: () => void;
}) {
    const sev = (issue.severity || "info").toLowerCase();
    return (
        <li>
            <button
                onClick={onClick}
                className="w-full text-left px-3.5 py-2.5 hover:bg-[var(--bg-input)]/40 transition-colors group"
            >
                <div className="flex items-center gap-2 mb-1">
                    <span
                        className={`w-1.5 h-1.5 rounded-full ${SEVERITY_DOT[sev] ?? SEVERITY_DOT.info}`}
                    />
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)]">
                        {issue.severity || "info"}
                    </span>
                    {issue.category && (
                        <span className="text-xs text-[var(--text-dim)]">
                            · {issue.category}
                        </span>
                    )}
                </div>
                <p className="text-sm text-[var(--text)] leading-snug line-clamp-2 group-hover:text-[var(--accent)] transition-colors">
                    {issue.message}
                </p>
                <p className="text-[11px] font-mono text-[var(--text-dim)] mt-1 truncate">
                    {basename(issue.file)}:{issue.line}
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
            className="rounded-xl border border-[var(--border)] bg-[var(--bg-2)]/70 backdrop-blur-sm overflow-hidden"
            style={{ boxShadow: "var(--shadow-card)" }}
        >
            <header className="px-3.5 py-2.5 border-b border-[var(--border)]/60 flex items-center justify-between">
                <p className="text-[10px] uppercase tracking-[0.14em] font-semibold text-[var(--text-dim)]">
                    {title}
                </p>
                {collapsible && onToggle && (
                    <button
                        onClick={onToggle}
                        className="text-[var(--text-dim)] hover:text-[var(--text-muted)] transition-colors"
                        aria-label={open ? "Collapse" : "Expand"}
                    >
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
            <span className="w-5 h-5 rounded-full bg-[var(--bg-3)] border border-[var(--border)] shrink-0" />
        );
    }
    return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={src}
            alt={alt}
            width={20}
            height={20}
            className="rounded-full shrink-0"
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
            }`}
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    );
}

function BugIcon() {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="currentColor"
            className="text-[var(--accent)]"
            aria-hidden
        >
            <circle cx="12" cy="12" r="3.5" />
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
            aria-hidden
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}

function DotMini() {
    return (
        <span className="w-1 h-1 rounded-full bg-current" aria-hidden />
    );
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
            aria-hidden
        >
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
            aria-hidden
        >
            <path d="M3 4h18v12H5l-2 4z" />
        </svg>
    );
}

function basename(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? path : path.slice(idx + 1);
}
