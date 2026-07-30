"use client";

import { cn } from "src/core/utils/components";

export const TogglePills = <T extends string>({
    options,
    value,
    onChange,
}: {
    options: Array<{ value: T; label: string }>;
    value: T;
    onChange: (value: T) => void;
}) => (
    <div className="bg-card-lv2 flex w-fit gap-0.5 rounded-full p-0.5">
        {options.map((option) => (
            <button
                key={option.value}
                type="button"
                onClick={() => onChange(option.value)}
                className={cn(
                    "rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors",
                    option.value === value
                        ? "bg-card-lv3 text-text-primary"
                        : "text-text-tertiary hover:text-text-secondary",
                )}>
                {option.label}
            </button>
        ))}
    </div>
);
