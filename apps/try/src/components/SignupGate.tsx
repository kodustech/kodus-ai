"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";

const SIGNUP_URL = "https://app.kodus.io/sign-up";

type GateReason = {
    title: string;
    body: string;
};

const DEFAULT_REASON: GateReason = {
    title: "Sign up to keep going",
    body: "This action is part of the full Kodus product. Create a free account to unlock copy-for-LLM prompts, file viewed tracking, settings, and reviews on every PR.",
};

type SignupGateContextValue = {
    open: (reason?: Partial<GateReason>) => void;
};

const SignupGateContext = createContext<SignupGateContextValue | null>(null);

export function SignupGateProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const [reason, setReason] = useState<GateReason | null>(null);

    const open = useCallback((override?: Partial<GateReason>) => {
        setReason({
            title: override?.title ?? DEFAULT_REASON.title,
            body: override?.body ?? DEFAULT_REASON.body,
        });
    }, []);

    const close = useCallback(() => setReason(null), []);

    useEffect(() => {
        if (!reason) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") close();
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [reason, close]);

    const value = useMemo(() => ({ open }), [open]);

    return (
        <SignupGateContext.Provider value={value}>
            {children}
            {reason && <SignupGateModal reason={reason} onClose={close} />}
        </SignupGateContext.Provider>
    );
}

export function useSignupGate() {
    const ctx = useContext(SignupGateContext);
    if (!ctx) {
        // Render outside the provider — return a noop so unit-tested
        // components don't blow up.
        return { open: () => undefined };
    }
    return ctx;
}

function SignupGateModal({
    reason,
    onClose,
}: {
    reason: GateReason;
    onClose: () => void;
}) {
    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="signup-gate-title"
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 py-6 bg-black/60 backdrop-blur-sm fade-up"
            style={{ animationDuration: "0.2s" }}
            onClick={onClose}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                className="relative w-full max-w-md rounded-xl border border-[var(--border-strong)] bg-[var(--bg-2)] overflow-hidden"
                style={{ boxShadow: "var(--shadow-elevated)" }}
            >
                <div
                    aria-hidden
                    className="absolute -top-20 -right-20 w-56 h-56 rounded-full bg-[var(--accent)]/15 blur-3xl pointer-events-none"
                />

                <button
                    onClick={onClose}
                    aria-label="Close"
                    className="absolute top-3 right-3 w-7 h-7 rounded-md text-[var(--text-dim)] hover:text-[var(--text)] hover:bg-[var(--bg-3)] flex items-center justify-center transition-colors z-10"
                >
                    <CloseIcon />
                </button>

                <div className="relative p-6">
                    <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-[var(--accent)]/30 bg-[var(--accent-soft)] text-[11px] text-[var(--accent)] font-medium mb-4">
                        <Sparkles />
                        Free with signup
                    </div>

                    <h2
                        id="signup-gate-title"
                        className="text-[20px] leading-tight font-medium text-[var(--text)] mb-2"
                    >
                        {reason.title}
                    </h2>
                    <p className="text-[14px] text-[var(--text-muted)] leading-relaxed mb-5">
                        {reason.body}
                    </p>

                    <ul className="space-y-1.5 mb-6">
                        {[
                            "Reviews on PRs of any size — no caps",
                            "Auto-reviews on every PR you open",
                            "Your own Kody rules per repo",
                            "GitHub, GitLab, Bitbucket, Azure DevOps",
                        ].map((perk) => (
                            <li
                                key={perk}
                                className="flex items-center gap-2 text-[13px] text-[var(--text)]"
                            >
                                <span className="text-[var(--accent)]">
                                    <CheckMark />
                                </span>
                                {perk}
                            </li>
                        ))}
                    </ul>

                    <div className="flex items-center gap-2">
                        <a
                            href={SIGNUP_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 inline-flex items-center justify-center gap-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] text-sm font-medium px-4 py-2.5 rounded-md transition-colors"
                            style={{
                                boxShadow:
                                    "0 0 0 1px rgba(248,183,109,0.4), 0 8px 24px -6px var(--accent-glow)",
                            }}
                        >
                            Sign up — free
                            <span aria-hidden>→</span>
                        </a>
                        <button
                            onClick={onClose}
                            className="text-sm text-[var(--text-muted)] hover:text-[var(--text)] px-3 py-2.5 transition-colors"
                        >
                            Not now
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function CloseIcon() {
    return (
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
    );
}

function Sparkles() {
    return (
        <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
        >
            <path d="M12 2l1.5 4.5L18 8l-4.5 1.5L12 14l-1.5-4.5L6 8l4.5-1.5L12 2z" />
        </svg>
    );
}

function CheckMark() {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}
