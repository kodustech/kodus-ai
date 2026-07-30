"use client";

import { useState } from "react";
import type { PrInfo, ReviewIssue } from "@/lib/api";
import { CopyButton } from "./CopyButton";
import { useSignupGate } from "./SignupGate";
import { TOKEN_STYLE, tokenize } from "@/lib/highlight";
import {
    buildLlmPromptForIssue,
    type PromptContext,
} from "@/lib/llm-prompt";

const KODY_AVATAR_URL = "https://avatars.githubusercontent.com/in/413034?v=4";

const LABEL_BY_SEVERITY: Record<string, string> = {
    critical: "Potential Bug",
    high: "Potential Bug",
    medium: "Suggestion",
    low: "Nit",
    info: "Note",
};

const ICON_TONE_BY_SEVERITY: Record<string, string> = {
    critical: "text-[var(--red)]",
    high: "text-[var(--red)]",
    medium: "text-[var(--yellow)]",
    low: "text-[var(--accent)]",
    info: "text-[var(--text-dim)]",
};

function sevKey(s?: string) {
    return (s ?? "info").toLowerCase();
}

export function SuggestionCard({
    issue,
    filePath,
    pr,
    promptCtx,
}: {
    issue: ReviewIssue;
    filePath: string;
    pr?: PrInfo;
    promptCtx: PromptContext;
}) {
    const [open, setOpen] = useState(true);
    const sev = sevKey(issue.severity);
    const label = LABEL_BY_SEVERITY[sev] ?? "Suggestion";
    const range =
        issue.endLine && issue.endLine !== issue.line
            ? `R${issue.line}-${issue.endLine}`
            : `R${issue.line}`;

    return (
        <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden my-2">
            <button
                onClick={() => setOpen((v) => !v)}
                className="w-full flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-[var(--bg-3)]/50 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <BugIcon tone={ICON_TONE_BY_SEVERITY[sev]} />
                    <span className="text-[13px] font-medium text-[var(--text)]">
                        {label}
                    </span>
                    <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded bg-[var(--bg-3)] border border-[var(--border)] text-[var(--text-muted)]">
                        {range}
                    </span>
                    {issue.category && (
                        <span className="text-[11px] text-[var(--text-dim)]">
                            · {issue.category}
                        </span>
                    )}
                </div>
                <Chevron open={open} />
            </button>

            {open && (
                <div className="border-t border-[var(--border)] px-4 py-3 space-y-3">
                    <Identity />
                    <RichBody text={issue.message} />
                    {issue.suggestion && (
                        <SuggestionBlock label="Suggested fix">
                            <RichBody text={issue.suggestion} muted />
                        </SuggestionBlock>
                    )}
                    {issue.recommendation && (
                        <SuggestionBlock label="Recommendation">
                            <RichBody text={issue.recommendation} muted />
                        </SuggestionBlock>
                    )}
                    <Footer
                        issue={issue}
                        filePath={filePath}
                        pr={pr}
                        promptCtx={promptCtx}
                    />
                    <ModelAttribution />
                </div>
            )}
        </section>
    );
}

function Identity() {
    return (
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                    src={KODY_AVATAR_URL}
                    alt=""
                    width={20}
                    height={20}
                    className="rounded-full ring-1 ring-[var(--border)]"
                />
                <span className="text-[13px] font-medium text-[var(--text)]">
                    Kody
                </span>
            </div>
            <button
                type="button"
                aria-label="More"
                className="text-[var(--text-dim)] hover:text-[var(--text-muted)] w-6 h-6 flex items-center justify-center rounded hover:bg-[var(--bg-3)]"
            >
                <DotsIcon />
            </button>
        </div>
    );
}

function SuggestionBlock({
    label,
    children,
}: {
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div>
            <p className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-dim)] font-semibold mb-1.5">
                {label}
            </p>
            {children}
        </div>
    );
}

function Footer({
    issue,
    filePath,
    pr,
    promptCtx,
}: {
    issue: ReviewIssue;
    filePath: string;
    pr?: PrInfo;
    promptCtx: PromptContext;
}) {
    const githubHref = pr ? `${pr.htmlUrl}/files` : undefined;

    return (
        <footer className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[var(--border)]/60">
            <CopyButton
                size="xs"
                label="Copy fix"
                getText={() =>
                    buildLlmPromptForIssue(
                        { ...issue, file: issue.file || filePath },
                        promptCtx,
                    )
                }
            />
            {githubHref && (
                <FooterAction
                    href={githubHref}
                    icon={<GithubIcon />}
                >
                    Open on GitHub
                </FooterAction>
            )}
        </footer>
    );
}

function ModelAttribution() {
    const { open } = useSignupGate();
    return (
        <p className="text-[11px] text-[var(--text-dim)] flex items-center justify-between gap-2 pt-2 -mt-1 flex-wrap">
            <span className="truncate">
                Reviewed by{" "}
                <code className="font-mono text-[var(--text-muted)]">
                    gemini-3-flash-preview
                </code>
            </span>
            <button
                type="button"
                onClick={() =>
                    open({
                        title: "Run reviews on your favorite model",
                        body: "The free demo uses Gemini 3 Flash. Sign up to switch to Claude Opus 4.7, GPT-5, Gemini 3 Pro, or your own provider key.",
                    })
                }
                className="text-[var(--accent)] hover:text-[var(--accent-hover)] transition-colors shrink-0"
            >
                Use your model →
            </button>
        </p>
    );
}

function FooterAction({
    children,
    icon,
    onClick,
    href,
}: {
    children: React.ReactNode;
    icon: React.ReactNode;
    onClick?: () => void;
    href?: string;
}) {
    const base =
        "inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md border border-[var(--border)] bg-[var(--bg-2)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-3)] transition-colors";
    if (href) {
        return (
            <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className={base}
            >
                {icon}
                {children}
            </a>
        );
    }
    return (
        <button type="button" onClick={onClick} className={base}>
            {icon}
            {children}
        </button>
    );
}

/**
 * Light markdown for the suggestion bodies:
 *   • triple backticks → fenced code block
 *   • single backticks → inline code
 *   • blank lines → paragraph breaks
 * Anything fancier (lists, headings) renders as plain text — most LLM
 * suggestions don't reach for it.
 */
function RichBody({ text, muted = false }: { text: string; muted?: boolean }) {
    const segments = splitFences(text);
    const colorClass = muted ? "text-[var(--text-muted)]" : "text-[var(--text)]";
    return (
        <div className={`text-[13.5px] leading-relaxed ${colorClass} space-y-2 min-w-0`}>
            {segments.map((seg, idx) => {
                if (seg.type === "code") {
                    return <CodeBlock key={idx} code={seg.content} />;
                }
                // Heuristic: LLMs often return raw source in
                // `suggestion`/`recommendation` without wrapping it in
                // triple backticks. If the chunk looks like code, render
                // it as a fenced block so the indentation survives.
                if (looksLikeCode(seg.content)) {
                    return <CodeBlock key={idx} code={seg.content.trim()} />;
                }
                return <Paragraphs key={idx} text={seg.content} />;
            })}
        </div>
    );
}

function looksLikeCode(text: string): boolean {
    if (!text.includes("\n")) return false;
    const lines = text.split("\n");
    if (lines.length < 2) return false;

    let indented = 0;
    let braceLines = 0;
    let semiLines = 0;
    let keywordHits = 0;
    const KW =
        /\b(function|const|let|var|return|if|else|for|while|class|interface|type|import|export|async|await|new|throw)\b/;

    for (const line of lines) {
        if (/^\s{2,}\S/.test(line)) indented++;
        if (/[{}]/.test(line)) braceLines++;
        if (/;\s*(\/\/.*)?$/.test(line)) semiLines++;
        if (KW.test(line)) keywordHits++;
    }

    // Strong signals: any of these mean "this is code, render verbatim".
    return (
        indented >= 1 ||
        braceLines >= 2 ||
        semiLines >= 2 ||
        keywordHits >= 2
    );
}

function CodeBlock({ code }: { code: string }) {
    const tokens = tokenize(code);
    return (
        <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] overflow-hidden">
            <pre className="overflow-x-auto px-3 py-2.5 text-[12.5px] leading-[1.65] font-mono whitespace-pre kodus-scroll">
                <code>
                    {tokens.map((tok, idx) => (
                        <span key={idx} style={TOKEN_STYLE[tok.kind]}>
                            {tok.text}
                        </span>
                    ))}
                </code>
            </pre>
        </div>
    );
}

function Paragraphs({ text }: { text: string }) {
    const paragraphs = text
        .replace(/\r\n/g, "\n")
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
    return (
        <>
            {paragraphs.map((p, idx) => (
                <p key={idx} className="break-words [overflow-wrap:anywhere]">
                    {renderInlineCode(p)}
                </p>
            ))}
        </>
    );
}

function renderInlineCode(text: string): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    const regex = /`([^`\n]+)`/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    let key = 0;
    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIdx) {
            parts.push(text.slice(lastIdx, match.index));
        }
        parts.push(
            <code
                key={`c-${key++}`}
                // `break-all` lets the long identifiers (camelCase
                // function names, file paths) wrap inside the card
                // instead of overflowing horizontally.
                className="font-mono text-[12px] px-1 py-px rounded bg-[var(--bg-3)] border border-[var(--border)] text-[var(--accent)] break-all"
            >
                {match[1]}
            </code>,
        );
        lastIdx = regex.lastIndex;
    }
    if (lastIdx < text.length) parts.push(text.slice(lastIdx));
    return parts;
}

function splitFences(text: string): Array<{ type: "text" | "code"; content: string }> {
    const out: Array<{ type: "text" | "code"; content: string }> = [];
    const regex = /```(?:\w+)?\n?([\s\S]*?)```/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIdx) {
            out.push({ type: "text", content: text.slice(lastIdx, match.index) });
        }
        out.push({ type: "code", content: match[1].trimEnd() });
        lastIdx = regex.lastIndex;
    }
    if (lastIdx < text.length) {
        out.push({ type: "text", content: text.slice(lastIdx) });
    }
    if (out.length === 0) out.push({ type: "text", content: text });
    return out;
}

function BugIcon({ tone }: { tone: string }) {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="currentColor"
            className={tone}
            aria-hidden
        >
            <circle cx="12" cy="12" r="3.5" />
        </svg>
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

function DotsIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
        >
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
        </svg>
    );
}

function GithubIcon() {
    return (
        <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden
        >
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
    );
}

