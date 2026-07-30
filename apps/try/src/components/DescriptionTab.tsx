"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PrInfo } from "@/lib/api";

const KODY_AVATAR_URL = "https://avatars.githubusercontent.com/in/413034?v=4";

export function DescriptionTab({ pr }: { pr: PrInfo }) {
    const hasAnalysis = !!pr.aiAnalysis?.trim();
    const hasBody = !!pr.body?.trim();

    return (
        <div className="space-y-6">
            {hasAnalysis && (
                <section
                    className="rounded-xl border border-[var(--border)] bg-gradient-to-br from-[var(--bg-2)] to-[var(--bg-3)]/40 overflow-hidden"
                    style={{ boxShadow: "var(--shadow-card)" }}
                >
                    <header className="flex items-center gap-2.5 px-5 py-3 border-b border-[var(--border)]/60">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={KODY_AVATAR_URL}
                            alt=""
                            width={22}
                            height={22}
                            className="rounded-full ring-1 ring-[var(--border)]"
                        />
                        <div className="min-w-0">
                            <p className="text-sm text-[var(--text)] font-medium">
                                Kody's analysis
                            </p>
                            <p className="text-[11px] text-[var(--text-dim)]">
                                Generated when this PR was submitted ·
                                gemini-3-flash-preview
                            </p>
                        </div>
                    </header>
                    <div className="px-5 py-4 markdown-body">
                        <Markdown>{pr.aiAnalysis!}</Markdown>
                    </div>
                </section>
            )}

            {hasBody ? (
                <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-2)]/60 overflow-hidden">
                    <header className="px-5 py-3 border-b border-[var(--border)]/60">
                        <p className="text-[10px] uppercase tracking-[0.14em] font-semibold text-[var(--text-dim)]">
                            Author's description
                        </p>
                    </header>
                    <div className="px-5 py-4 markdown-body">
                        <Markdown>{pr.body!}</Markdown>
                    </div>
                </section>
            ) : (
                !hasAnalysis && (
                    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)]/60 px-5 py-6 text-center text-sm text-[var(--text-muted)]">
                        No description yet.
                    </div>
                )
            )}
        </div>
    );
}

function Markdown({ children }: { children: string }) {
    return (
        <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
                p: ({ children }) => (
                    <p className="text-[14px] text-[var(--text)] leading-relaxed mb-3 last:mb-0">
                        {children}
                    </p>
                ),
                strong: ({ children }) => (
                    <strong className="text-[var(--text)] font-semibold">
                        {children}
                    </strong>
                ),
                em: ({ children }) => (
                    <em className="text-[var(--text-muted)]">{children}</em>
                ),
                ul: ({ children }) => (
                    <ul className="space-y-1.5 mb-3 text-[14px] text-[var(--text)]">
                        {children}
                    </ul>
                ),
                ol: ({ children }) => (
                    <ol className="list-decimal pl-5 space-y-1.5 mb-3 text-[14px] text-[var(--text)]">
                        {children}
                    </ol>
                ),
                li: ({ children }) => (
                    <li className="flex gap-2 leading-relaxed">
                        <span className="text-[var(--accent)] shrink-0 select-none">
                            ›
                        </span>
                        <span className="min-w-0">{children}</span>
                    </li>
                ),
                code: ({ children, className }) => {
                    const isBlock = className?.startsWith("language-");
                    if (isBlock) {
                        return (
                            <code className="block bg-[var(--bg)] border border-[var(--border)] rounded px-3 py-2 my-3 text-[12.5px] font-mono text-[var(--text)] overflow-x-auto whitespace-pre">
                                {children}
                            </code>
                        );
                    }
                    return (
                        <code className="font-mono text-[12.5px] px-1 py-px rounded bg-[var(--bg-3)] border border-[var(--border)] text-[var(--accent)] break-all">
                            {children}
                        </code>
                    );
                },
                pre: ({ children }) => <>{children}</>,
                a: ({ href, children }) => (
                    <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--accent)] hover:text-[var(--accent-hover)] underline underline-offset-2"
                    >
                        {children}
                    </a>
                ),
                h1: ({ children }) => (
                    <h3 className="text-[15px] font-semibold text-[var(--text)] mt-4 mb-2">
                        {children}
                    </h3>
                ),
                h2: ({ children }) => (
                    <h3 className="text-[15px] font-semibold text-[var(--text)] mt-4 mb-2">
                        {children}
                    </h3>
                ),
                h3: ({ children }) => (
                    <h4 className="text-[14px] font-semibold text-[var(--text)] mt-3 mb-1.5">
                        {children}
                    </h4>
                ),
                hr: () => (
                    <hr className="my-4 border-[var(--border)]/50" />
                ),
                blockquote: ({ children }) => (
                    <blockquote className="border-l-2 border-[var(--border-strong)] pl-3 text-[var(--text-muted)] italic my-3">
                        {children}
                    </blockquote>
                ),
            }}
        >
            {children}
        </ReactMarkdown>
    );
}
