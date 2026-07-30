"use client";

import Link from "next/link";
import {
    Gauge,
    GitPullRequest,
    Info,
    LibraryBig,
    Terminal,
    type LucideIcon,
} from "lucide-react";
import { KodusLogo } from "./icons/KodusLogo";
import { useSignupGate } from "./SignupGate";

const STAR_URL = "https://github.com/kodustech/kodus-ai";
const SIGNUP_URL = "https://app.kodus.io/sign-up";
const LOGIN_URL = "https://app.kodus.io/sign-in";

type NavItem = {
    label: string;
    icon: LucideIcon;
    /** Reason copy shown inside the signup modal when this item is clicked. */
    gate: {
        title: string;
        body: string;
    };
};

const NAV_ITEMS: NavItem[] = [
    {
        label: "Cockpit",
        icon: Gauge,
        gate: {
            title: "Cockpit — your team's PR health, live",
            body: "Live dashboard of PR velocity, review turnaround and bug ratio across the team — refreshed in real time. Sign up to plug your repos in.",
        },
    },
    {
        label: "Library",
        icon: LibraryBig,
        gate: {
            title: "Kody Rules Library",
            body: "Your Kody Rules, version-controlled per repo. Reuse what works, propagate fixes across the team, and let Kody enforce them on every PR.",
        },
    },
    {
        label: "Issues",
        icon: Info,
        gate: {
            title: "Recurring issues, tracked",
            body: "Bugs Kody flagged across PRs grouped into actionable issues. See patterns that keep popping up and which teams own them.",
        },
    },
    {
        label: "Pull Requests",
        icon: GitPullRequest,
        gate: {
            title: "Every PR, reviewed",
            body: "Timeline of every PR Kody has reviewed for your team — comments, severity, time saved. Searchable, filterable, exportable.",
        },
    },
    {
        label: "CLI Reviews",
        icon: Terminal,
        gate: {
            title: "Kody in your terminal",
            body: "Run the same review locally with `npx kodus review` — pre-commit feedback, zero setup. Same engine, same suggestions.",
        },
    },
];

/**
 * Shared shell header. Mirrors the apps/web NavMenu — two-pixel peach
 * border under a card-lv1 bar — so try.kodus.io reads as the same
 * product as the authenticated app.
 *
 * The nav items are click-baits in the friendliest sense: every one
 * pops the signup modal with feature-specific copy, so visitors who
 * explore the chrome get a clear, contextual reason to sign up.
 */
export function MainHeader({
    rightExtra,
    leftExtra,
}: {
    /** Optional right slot before the auth buttons. */
    rightExtra?: React.ReactNode;
    /** Optional slot right after the logo (e.g. file-tree toggle). */
    leftExtra?: React.ReactNode;
}) {
    const { open: openGate } = useSignupGate();

    return (
        <header
            className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-4 border-b-2 px-6 bg-[var(--bg-2)]/95 backdrop-blur-md"
            style={{ borderBottomColor: "var(--accent-dark)" }}
        >
            <Link
                href="/"
                aria-label="Kodus"
                className="flex items-center shrink-0"
            >
                <KodusLogo className="h-7" />
            </Link>

            {leftExtra}

            <nav className="hidden xl:flex items-center h-full flex-1 min-w-0">
                {NAV_ITEMS.map((item) => (
                    <NavItemButton
                        key={item.label}
                        item={item}
                        onPick={() => openGate(item.gate)}
                    />
                ))}
            </nav>

            {/* Spacer when the nav items aren't visible — keeps the
                right-side controls hugging the right edge instead of
                hugging the logo. */}
            <div className="flex-1 xl:hidden" />

            <div className="flex items-center gap-3 shrink-0">
                {rightExtra}

                <a
                    href={STAR_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hidden sm:inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text)] border border-transparent hover:border-[var(--border-strong)] hover:bg-[var(--bg-3)] transition-all"
                >
                    <StarIcon />
                    Star on GitHub
                </a>

                <a
                    href={LOGIN_URL}
                    className="text-sm text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                >
                    Log in
                </a>

                <a
                    href={SIGNUP_URL}
                    className="text-sm font-medium text-[var(--accent-fg)] bg-[var(--accent)] hover:bg-[var(--accent-hover)] px-3.5 py-1.5 rounded-md transition-colors"
                    style={{
                        boxShadow:
                            "0 0 0 1px rgba(248,183,109,0.4), 0 6px 18px -6px var(--accent-glow)",
                    }}
                >
                    Sign up
                </a>
            </div>
        </header>
    );
}

function NavItemButton({
    item,
    onPick,
}: {
    item: NavItem;
    onPick: () => void;
}) {
    const Icon = item.icon;
    return (
        <button
            type="button"
            onClick={onPick}
            // Mirrors apps/web NavMenu: text-tertiary by default, white
            // on hover. The underline is drawn via box-shadow (instead
            // of border-b) so the rest state doesn't reserve 2px of
            // padding that conflicts with the navbar's bottom border.
            className="group relative h-full flex items-center gap-2 px-4 text-sm text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
        >
            <Icon className="size-[18px]" strokeWidth={1.75} />
            {item.label}
            <span
                aria-hidden
                className="pointer-events-none absolute inset-x-3 -bottom-[2px] h-[2px] bg-[var(--accent)] opacity-0 group-hover:opacity-100 transition-opacity"
            />
        </button>
    );
}

function StarIcon() {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden
        >
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
    );
}
