const SIGNUP_URL = "https://app.kodus.io/sign-up";

export function SignupBanner({ reason }: { reason?: string }) {
    return (
        <div
            className="rounded-xl border border-[var(--border-strong)] bg-gradient-to-br from-[var(--bg-3)] to-[var(--bg-2)] px-5 py-4 flex flex-wrap items-center justify-between gap-3 relative overflow-hidden"
            style={{ boxShadow: "var(--shadow-card)" }}
        >
            <div
                aria-hidden
                className="absolute -right-12 -top-12 w-40 h-40 rounded-full bg-[var(--accent)]/10 blur-2xl pointer-events-none"
            />
            <div className="relative">
                <p className="text-sm text-[var(--text)] font-medium">
                    {reason ??
                        "Reviews on every PR, your own kody rules, private repos."}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                    Connect GitHub and Kodus reviews every PR you open.
                </p>
            </div>
            <a
                href={SIGNUP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="relative text-sm font-medium bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] px-4 py-2 rounded-md transition-colors inline-flex items-center gap-1.5"
                style={{
                    boxShadow:
                        "0 0 0 1px rgba(248,183,109,0.4), 0 8px 24px -6px var(--accent-glow)",
                }}
            >
                Sign up — free
                <span aria-hidden>→</span>
            </a>
        </div>
    );
}
