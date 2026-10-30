"use client";

import { LayoutGridIcon, Rows3Icon } from "lucide-react";
import { cn } from "src/core/utils/components";

export type KodyRulesViewMode = "table" | "cards";

// Persisted per browser, not per URL: the view is a personal reading
// preference, not part of a shareable filter state.
const STORAGE_KEY = "kodus:kody-rules:view";

export const readStoredViewMode = (): KodyRulesViewMode | null => {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        return raw === "table" || raw === "cards" ? raw : null;
    } catch {
        return null;
    }
};

export const storeViewMode = (mode: KodyRulesViewMode) => {
    try {
        window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
        // Private mode / blocked storage — the choice just won't persist.
    }
};

const OPTIONS: Array<{
    value: KodyRulesViewMode;
    label: string;
    Icon: typeof Rows3Icon;
}> = [
    { value: "table", label: "Table view", Icon: Rows3Icon },
    { value: "cards", label: "Card view", Icon: LayoutGridIcon },
];

// Two-state segmented control (table | cards). Plain buttons with a native
// `title` on purpose: the toolbar already avoids Radix Slot chains (see the
// comments in toolbar.tsx) and a tooltip adds nothing over the label here.
export const KodyRulesViewSwitcher = ({
    value,
    onChange,
}: {
    value: KodyRulesViewMode;
    onChange: (mode: KodyRulesViewMode) => void;
}) => (
    <div
        role="radiogroup"
        aria-label="View mode"
        className="border-card-lv3 bg-card-lv2 flex h-10 shrink-0 items-center gap-0.5 rounded-xl border p-1">
        {OPTIONS.map(({ value: option, label, Icon }) => {
            const active = option === value;
            return (
                <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={label}
                    title={label}
                    onClick={() => onChange(option)}
                    className={cn(
                        "focus-visible:ring-primary-light flex size-8 items-center justify-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2",
                        active
                            ? "bg-card-lv3 text-text-primary shadow-sm"
                            : "text-text-tertiary hover:bg-card-lv3/50 hover:text-text-secondary",
                    )}>
                    <Icon className="size-4" aria-hidden />
                </button>
            );
        })}
    </div>
);
