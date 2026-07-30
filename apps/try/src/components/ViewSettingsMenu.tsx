"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Preferences, DiffStyle } from "@/lib/preferences";
import { useSignupGate } from "./SignupGate";

export function ViewSettingsMenu({
    prefs,
    onChange,
    onExpandAll,
    onCollapseAll,
    gated,
}: {
    prefs: Preferences;
    onChange: (next: Preferences) => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    /** When true, opening the menu fires the signup gate instead. */
    gated?: boolean;
}) {
    const { open: openGate } = useSignupGate();
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDocClick = (e: MouseEvent) => {
            const target = e.target as Node;
            // Menu lives in a portal outside containerRef, so check
            // both — only close when the click is outside everywhere.
            if (
                containerRef.current?.contains(target) ||
                menuRef.current?.contains(target)
            ) {
                return;
            }
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onDocClick);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDocClick);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const setDiffStyle = (s: DiffStyle) =>
        onChange({ ...prefs, diffStyle: s });
    const toggleHide = () =>
        onChange({ ...prefs, hideHighlights: !prefs.hideHighlights });

    const onTriggerClick = () => {
        if (gated) {
            openGate({
                title: "Sign up to customize the view",
                body: "Diff layout, comment density, expand/collapse — these stick to your account so every PR you review looks the way you want.",
            });
            return;
        }
        setOpen((v) => !v);
    };

    // Compute the on-screen position of the trigger so the portal-
    // rendered menu can anchor right-aligned beneath it, without being
    // trapped by any ancestor's stacking context (asides, transforms,
    // backdrop-filters, etc.).
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [menuPos, setMenuPos] = useState<{
        top: number;
        right: number;
    } | null>(null);

    useLayoutEffect(() => {
        if (!open || !triggerRef.current) {
            setMenuPos(null);
            return;
        }
        const rect = triggerRef.current.getBoundingClientRect();
        setMenuPos({
            top: rect.bottom + 8,
            right: window.innerWidth - rect.right,
        });
    }, [open]);

    return (
        <div ref={containerRef} className="relative">
            <button
                ref={triggerRef}
                onClick={onTriggerClick}
                className={`w-8 h-8 rounded-md border transition-colors inline-flex items-center justify-center ${
                    open
                        ? "border-[var(--accent)]/60 bg-[var(--bg-3)] text-[var(--text)]"
                        : "border-[var(--border-strong)] bg-[var(--bg-2)] text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--accent)]/40"
                }`}
                aria-label="View settings"
                aria-haspopup="menu"
                aria-expanded={open}
            >
                <SlidersIcon />
            </button>

            {open && menuPos && typeof document !== "undefined" &&
                createPortal(
                <div
                    ref={menuRef}
                    role="menu"
                    // Rendered into document.body via portal so no
                    // ancestor (sticky aside, transformed grid,
                    // backdrop-filter header) can swallow it. Position
                    // tracked from the trigger's rect.
                    className="fixed w-56 rounded-lg border border-[var(--border-strong)] bg-[var(--bg-2)] py-1.5"
                    style={{
                        top: menuPos.top,
                        right: menuPos.right,
                        zIndex: 1000,
                        boxShadow: "var(--shadow-elevated)",
                    }}
                >
                    <SectionLabel>Diff view</SectionLabel>
                    <MenuItem
                        active={prefs.diffStyle === "split"}
                        onClick={() => setDiffStyle("split")}
                    >
                        Split view
                    </MenuItem>
                    <MenuItem
                        active={prefs.diffStyle === "unified"}
                        onClick={() => setDiffStyle("unified")}
                    >
                        Unified view
                    </MenuItem>

                    <Divider />

                    <SectionLabel>Comments</SectionLabel>
                    <MenuItem
                        active={prefs.hideHighlights}
                        onClick={toggleHide}
                    >
                        Hide inline suggestions
                    </MenuItem>

                    <Divider />

                    <SectionLabel>Files</SectionLabel>
                    <MenuItem
                        onClick={() => {
                            onExpandAll();
                            setOpen(false);
                        }}
                    >
                        Expand all
                    </MenuItem>
                    <MenuItem
                        onClick={() => {
                            onCollapseAll();
                            setOpen(false);
                        }}
                    >
                        Collapse all
                    </MenuItem>
                </div>,
                document.body,
            )}
        </div>
    );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <p className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-[0.16em] font-semibold text-[var(--text-dim)]">
            {children}
        </p>
    );
}

function Divider() {
    return <div className="my-1 border-t border-[var(--border)]/70" />;
}

function MenuItem({
    children,
    active,
    onClick,
}: {
    children: React.ReactNode;
    active?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            role="menuitem"
            onClick={onClick}
            className="w-full text-left px-3 py-1.5 text-[13px] text-[var(--text)] hover:bg-[var(--bg-3)] transition-colors flex items-center justify-between gap-3"
        >
            <span>{children}</span>
            {active && <CheckIcon />}
        </button>
    );
}

function SlidersIcon() {
    return (
        <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="4" y1="21" x2="4" y2="14" />
            <line x1="4" y1="10" x2="4" y2="3" />
            <line x1="12" y1="21" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12" y2="3" />
            <line x1="20" y1="21" x2="20" y2="16" />
            <line x1="20" y1="12" x2="20" y2="3" />
            <line x1="1" y1="14" x2="7" y2="14" />
            <line x1="9" y1="8" x2="15" y2="8" />
            <line x1="17" y1="16" x2="23" y2="16" />
        </svg>
    );
}

function CheckIcon() {
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
            className="text-[var(--accent)]"
        >
            <polyline points="20 6 9 17 4 12" />
        </svg>
    );
}
