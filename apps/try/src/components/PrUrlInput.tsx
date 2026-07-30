"use client";

import { useState } from "react";

const PR_URL_PATTERN =
    /^https?:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+\/pull\/\d+/i;

export function PrUrlInput({
    onSubmit,
    initialValue,
    disabled,
    autoFocus,
}: {
    onSubmit: (url: string) => void;
    initialValue?: string;
    disabled?: boolean;
    autoFocus?: boolean;
}) {
    const [value, setValue] = useState(initialValue ?? "");
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (!PR_URL_PATTERN.test(trimmed)) {
            setError(
                "URL must look like github.com/owner/repo/pull/123",
            );
            return;
        }
        setError(null);
        onSubmit(trimmed);
    };

    return (
        <form onSubmit={handleSubmit} className="w-full">
            <div
                className="focus-ring relative flex items-stretch gap-0 rounded-xl border border-[var(--border-strong)] bg-[var(--bg-2)]/80 backdrop-blur-sm transition-all"
                style={{ boxShadow: "var(--shadow-card)" }}
            >
                <span
                    aria-hidden
                    className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-dim)]"
                >
                    <GithubMark />
                </span>
                <input
                    type="url"
                    value={value}
                    onChange={(e) => {
                        setValue(e.target.value);
                        if (error) setError(null);
                    }}
                    placeholder="github.com/owner/repo/pull/123"
                    disabled={disabled}
                    autoFocus={autoFocus}
                    aria-label="GitHub PR URL"
                    className="flex-1 bg-transparent pl-12 pr-3 py-4 text-[15px] text-[var(--text)] placeholder:text-[var(--text-dim)] outline-none disabled:opacity-50 font-mono"
                />
                <button
                    type="submit"
                    disabled={disabled || !value.trim()}
                    className="relative m-1.5 px-5 py-2.5 rounded-lg text-sm font-medium tracking-tight bg-[var(--accent)] text-[var(--accent-fg)] hover:bg-[var(--accent-hover)] disabled:bg-[var(--bg-4)] disabled:text-[var(--text-dim)] disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
                    style={{
                        boxShadow: disabled
                            ? "none"
                            : "0 0 0 1px rgba(248,183,109,0.4), 0 8px 24px -6px var(--accent-glow)",
                    }}
                >
                    Review
                    <ArrowRight />
                </button>
            </div>
            {error && (
                <p className="mt-2.5 text-sm text-[var(--red)] flex items-center gap-1.5">
                    <DotIcon /> {error}
                </p>
            )}
        </form>
    );
}

function GithubMark() {
    return (
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
    );
}

function ArrowRight() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="5" y1="12" x2="19" y2="12" />
            <polyline points="12 5 19 12 12 19" />
        </svg>
    );
}

function DotIcon() {
    return (
        <span className="inline-block w-1 h-1 rounded-full bg-[var(--red)]" />
    );
}
