import type { ReactNode } from "react";
import { Heading } from "@components/ui/heading";
import { cn } from "src/core/utils/components";

/**
 * A titled group of settings: the title and one line of context sit above a
 * card whose rows each pair a setting, on the left, with its control, on
 * the right.
 */
export const SettingsGroup = ({
    title,
    description,
    children,
}: {
    title: string;
    description?: ReactNode;
    children: ReactNode;
}) => (
    <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
            <Heading variant="h3">{title}</Heading>
            {description && (
                <p className="text-text-secondary text-sm">{description}</p>
            )}
        </div>
        <div className="bg-card-lv2 divide-card-lv3 divide-y rounded-xl">
            {children}
        </div>
    </section>
);

export const SettingsRow = ({
    title,
    description,
    control,
    htmlFor,
    children,
    className,
}: {
    title: ReactNode;
    description?: ReactNode;
    /** The switch, select or button on the right. */
    control?: ReactNode;
    /** The control's id, so the title labels it. */
    htmlFor?: string;
    /** Shown under the row, full width: a field the setting opens up. */
    children?: ReactNode;
    className?: string;
}) => (
    <div className={cn("flex flex-col gap-4 px-5 py-4", className)}>
        <div className="flex items-center justify-between gap-8">
            <div className="flex min-w-0 flex-col gap-1">
                {htmlFor ? (
                    <label
                        htmlFor={htmlFor}
                        className="text-text-primary text-sm font-medium">
                        {title}
                    </label>
                ) : (
                    <span className="text-text-primary text-sm font-medium">
                        {title}
                    </span>
                )}
                {description && (
                    <span className="text-text-secondary text-sm">
                        {description}
                    </span>
                )}
            </div>
            {control && <div className="shrink-0">{control}</div>}
        </div>
        {children}
    </div>
);
