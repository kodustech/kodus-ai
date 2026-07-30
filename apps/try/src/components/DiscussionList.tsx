"use client";

import type { PrComment } from "@/lib/api";

export function DiscussionList({ comments }: { comments: PrComment[] }) {
    if (comments.length === 0) {
        return (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)]/60 px-5 py-8 text-center">
                <p className="text-sm text-[var(--text)] font-medium">
                    No discussion yet
                </p>
                <p className="text-sm text-[var(--text-muted)] mt-1">
                    Be the first to comment on the PR upstream.
                </p>
            </div>
        );
    }
    return (
        <ul className="space-y-3">
            {comments.map((c) => (
                <li key={c.id}>
                    <article className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)]/60 overflow-hidden">
                        <header className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-[var(--border)]/60 bg-[var(--bg)]">
                            <div className="flex items-center gap-2 min-w-0">
                                {c.authorAvatarUrl && (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                        src={c.authorAvatarUrl}
                                        alt=""
                                        width={20}
                                        height={20}
                                        className="rounded-full shrink-0"
                                    />
                                )}
                                <span className="text-sm font-medium text-[var(--text)] truncate">
                                    {c.authorLogin ?? "unknown"}
                                </span>
                                <span className="text-[11px] text-[var(--text-dim)] shrink-0">
                                    · {relativeTime(c.createdAt)}
                                </span>
                                {c.kind === "review" && c.path && (
                                    <span className="text-[11px] font-mono text-[var(--text-dim)] truncate hidden sm:inline">
                                        · {basename(c.path)}
                                        {c.line ? `:${c.line}` : ""}
                                    </span>
                                )}
                            </div>
                            <a
                                href={c.htmlUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] text-[var(--text-dim)] hover:text-[var(--text-muted)] shrink-0"
                            >
                                View ↗
                            </a>
                        </header>
                        <div className="px-4 py-3 text-sm text-[var(--text)] leading-relaxed whitespace-pre-wrap break-words">
                            {c.body || (
                                <span className="text-[var(--text-dim)] italic">
                                    (empty comment)
                                </span>
                            )}
                        </div>
                    </article>
                </li>
            ))}
        </ul>
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

function basename(path: string): string {
    const idx = path.lastIndexOf("/");
    return idx === -1 ? path : path.slice(idx + 1);
}
