import type { ReactNode } from "react";
import type { Tone } from "@services/runtime/labels";
import { cn } from "src/core/utils/components";

const TONE_CLASS: Record<Tone, string> = {
    success: "bg-success/15 text-success",
    danger: "bg-danger/15 text-danger",
    warning: "bg-warning/15 text-warning",
    alert: "bg-alert/15 text-alert",
    info: "bg-info/15 text-info",
    neutral: "bg-card-lv2 text-text-secondary",
};

/** The solid dot of a tone, for timelines. */
export const TONE_DOT_CLASS: Record<Tone, string> = {
    success: "bg-success",
    danger: "bg-danger",
    warning: "bg-warning",
    alert: "bg-alert",
    info: "bg-info",
    neutral: "bg-text-tertiary",
};

/** The text colour of a tone, for icons next to a status. */
export const TONE_TEXT_CLASS: Record<Tone, string> = {
    success: "text-success",
    danger: "text-danger",
    warning: "text-warning",
    alert: "text-alert",
    info: "text-info",
    neutral: "text-text-tertiary",
};

/** A status as a tinted chip: the hue says the meaning, never the accent. */
export const StatusChip = ({
    tone,
    children,
    className,
}: {
    tone: Tone;
    children: ReactNode;
    className?: string;
}) => (
    <span
        className={cn(
            "inline-flex w-fit items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap",
            TONE_CLASS[tone],
            className,
        )}>
        {children}
    </span>
);
