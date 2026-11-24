import type { ComponentProps } from "react";
import { cn } from "src/core/utils/components";

/**
 * One line that, when too long, cuts from the start and keeps the end: where a
 * model's id or a file path tells two items apart. The inner `bdi` keeps the
 * text itself left-to-right, so a closing ")" or "/" stays at the end.
 */
export function TruncateStart({
    className,
    children,
    ...props
}: ComponentProps<"span">) {
    return (
        <span
            {...props}
            dir="rtl"
            className={cn("truncate text-left", className)}>
            <bdi dir="ltr">{children}</bdi>
        </span>
    );
}
