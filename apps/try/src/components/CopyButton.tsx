"use client";

import { useState } from "react";
import { useSignupGate } from "./SignupGate";

export function CopyButton({
    getText,
    label = "Copy for LLM",
    size = "sm",
    gateReason,
}: {
    getText: () => string;
    label?: string;
    size?: "sm" | "xs";
    /**
     * When provided, the button opens the signup gate instead of
     * copying. Used for the public demo to push interactive features
     * behind sign up while keeping the read-only review free.
     */
    gateReason?: { title?: string; body?: string } | true;
}) {
    const { open } = useSignupGate();
    const [copied, setCopied] = useState(false);

    const onClick = async () => {
        if (gateReason) {
            open(
                typeof gateReason === "object"
                    ? gateReason
                    : {
                          title: "Sign up to copy LLM prompts",
                          body: "Copy-for-LLM is part of the full Kodus product. Create a free account to copy structured prompts straight into Cursor, Claude Code or ChatGPT.",
                      },
            );
            return;
        }

        try {
            await navigator.clipboard.writeText(getText());
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch {
            const ta = document.createElement("textarea");
            ta.value = getText();
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            try {
                document.execCommand("copy");
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
            } catch {
                /* swallow */
            }
            document.body.removeChild(ta);
        }
    };

    const sizeClasses =
        size === "xs" ? "text-[10.5px] px-2 py-1" : "text-xs px-2.5 py-1.5";

    return (
        <button
            type="button"
            onClick={onClick}
            className={`${sizeClasses} font-mono rounded-md border transition-all inline-flex items-center gap-1.5 ${
                copied
                    ? "border-[var(--green)]/40 bg-[var(--green)]/10 text-[var(--green)]"
                    : "border-[var(--border-strong)] bg-[var(--bg-3)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--accent)]/60 hover:bg-[var(--bg-4)]"
            }`}
            aria-label={label}
        >
            {copied ? (
                <>
                    <CheckIcon /> Copied
                </>
            ) : (
                <>
                    <CopyIcon /> {label}
                </>
            )}
        </button>
    );
}

function CopyIcon() {
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
            aria-hidden="true"
        >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
    );
}

function CheckIcon() {
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
            aria-hidden="true"
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}
