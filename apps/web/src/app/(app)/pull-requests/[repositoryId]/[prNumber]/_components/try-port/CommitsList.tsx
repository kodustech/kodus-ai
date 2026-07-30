"use client";

import type { PrCommit } from "./types";

export function CommitsList({ commits }: { commits: PrCommit[] }) {
    if (commits.length === 0) {
        return (
            <EmptyState
                title="No commits"
                body="This PR doesn't have any commits — or we couldn't fetch them."
            />
        );
    }
    return (
        <ul className="space-y-2">
            {commits.map((commit) => (
                <li key={commit.sha}>
                    <a
                        href={commit.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="group block rounded-lg border border-[var(--border)] bg-[var(--bg-2)]/60 hover:bg-[var(--bg-3)] hover:border-[var(--border-strong)] px-4 py-3 transition-colors"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                                <p className="text-sm text-[var(--text)] truncate mb-1.5 leading-snug">
                                    {commit.message ||
                                        "(no commit message)"}
                                </p>
                                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                                    {commit.authorAvatarUrl && (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img
                                            src={commit.authorAvatarUrl}
                                            alt=""
                                            width={16}
                                            height={16}
                                            className="rounded-full"
                                        />
                                    )}
                                    {commit.authorLogin && (
                                        <span className="text-[var(--text)]">
                                            {commit.authorLogin}
                                        </span>
                                    )}
                                    {commit.authoredAt && (
                                        <>
                                            <span className="text-[var(--text-dim)]">
                                                ·
                                            </span>
                                            <span className="text-[var(--text-dim)]">
                                                {relativeTime(
                                                    commit.authoredAt,
                                                )}
                                            </span>
                                        </>
                                    )}
                                </div>
                            </div>
                            <span className="font-mono text-[12px] text-[var(--text-muted)] group-hover:text-[var(--accent)] transition-colors shrink-0 px-2 py-0.5 rounded bg-[var(--bg-3)] border border-[var(--border)]">
                                {commit.sha.slice(0, 7)}
                            </span>
                        </div>
                    </a>
                </li>
            ))}
        </ul>
    );
}

function EmptyState({ title, body }: { title: string; body: string }) {
    return (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)]/60 px-5 py-8 text-center">
            <p className="text-sm text-[var(--text)] font-medium">{title}</p>
            <p className="text-sm text-[var(--text-muted)] mt-1">{body}</p>
        </div>
    );
}

function relativeTime(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const seconds = Math.max(1, Math.floor((Date.now() - then) / 1000));
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);

    if (years >= 1) return `${years}y ago`;
    if (months >= 1) return `${months}mo ago`;
    if (days >= 1) return `${days}d ago`;
    if (hours >= 1) return `${hours}h ago`;
    if (minutes >= 1) return `${minutes}m ago`;
    return "just now";
}
