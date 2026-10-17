"use client";

import type { PropsWithChildren, ReactNode } from "react";
import { Card } from "@components/ui/card";
import { cn } from "src/core/utils/components";

/** A titled card, the unit every section of the agent page uses. */
export const Section = ({
    title,
    description,
    actions,
    children,
    className,
}: PropsWithChildren<{
    title: string;
    description?: ReactNode;
    actions?: ReactNode;
    className?: string;
}>) => (
    <Card
        color="lv1"
        className={cn("flex flex-col gap-4 px-5 py-4", className)}>
        <div className="flex flex-wrap items-start justify-between gap-3">
            <span className="flex flex-col">
                <span className="text-text-primary text-sm font-medium">
                    {title}
                </span>
                {description && (
                    <span className="text-text-secondary text-xs">
                        {description}
                    </span>
                )}
            </span>
            {actions}
        </div>
        {children}
    </Card>
);

export const Field = ({
    label,
    hint,
    children,
    htmlFor,
}: PropsWithChildren<{
    label: string;
    hint?: ReactNode;
    htmlFor?: string;
}>) => (
    <div className="flex flex-col gap-1.5">
        <label
            htmlFor={htmlFor}
            className="text-text-primary text-xs font-medium">
            {label}
        </label>
        {children}
        {hint && <span className="text-text-tertiary text-xs">{hint}</span>}
    </div>
);

export const Chip = ({
    children,
    tone = "neutral",
}: PropsWithChildren<{ tone?: "neutral" | "warning" | "danger" }>) => (
    <span
        className={cn(
            "inline-flex h-5 items-center rounded px-1.5 text-xs font-medium",
            tone === "neutral" && "bg-card-lv2 text-text-secondary",
            tone === "warning" && "bg-warning/10 text-warning",
            tone === "danger" && "bg-danger/10 text-danger",
        )}>
        {children}
    </span>
);

/** Segmented choice between a few options. */
export const Choice = <T extends string>({
    value,
    options,
    onChange,
    disabled,
    label,
    size = "md",
}: {
    value: T;
    options: Array<{ value: T; label: string }>;
    onChange: (value: T) => void;
    disabled?: boolean;
    /** Names the group when no visible label does. */
    label?: string;
    size?: "sm" | "md";
}) => (
    <div
        role="group"
        aria-label={label}
        className={cn(
            "bg-card-lv2 inline-flex w-fit rounded-lg",
            size === "sm" ? "gap-0.5 p-0.5" : "gap-1 p-1",
        )}>
        {options.map((option) => (
            <button
                key={option.value}
                type="button"
                aria-pressed={value === option.value}
                disabled={disabled}
                onClick={() => onChange(option.value)}
                className={cn(
                    "rounded-md text-xs font-medium transition-colors disabled:opacity-60",
                    size === "sm" ? "px-2 py-0.5" : "px-3 py-1",
                    value === option.value
                        ? "bg-card-lv1 text-text-primary"
                        : "text-text-secondary hover:text-text-primary",
                )}>
                {option.label}
            </button>
        ))}
    </div>
);
