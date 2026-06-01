"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { AlertCircle, RefreshCw } from "lucide-react";
import { cn } from "src/core/utils/components";

import { Button } from "./button";

const errorCardVariants = cva("flex items-center text-text-secondary", {
    variants: {
        variant: {
            card: "flex-col justify-center gap-3 p-6 text-center bg-card-lv1 border border-card-lv3 rounded-xl m-10",
            inline: "justify-center gap-3 p-4",
            minimal: "gap-2 text-sm",
        },
    },
    defaultVariants: {
        variant: "inline",
    },
});

interface ErrorCardProps
    extends
        React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof errorCardVariants> {
    message?: string;
    onRetry?: () => void;
}

const ErrorCard = React.forwardRef<HTMLDivElement, ErrorCardProps>(
    (
        {
            message = "It looks like we couldn't fetch the data.",
            onRetry,
            variant,
            className,
            ...props
        },
        ref,
    ) => {
        const iconSize =
            variant === "card"
                ? "size-8"
                : variant === "minimal"
                  ? "size-4"
                  : "size-5";

        return (
            <div
                ref={ref}
                className={cn(errorCardVariants({ variant }), className)}
                {...props}>
                <AlertCircle className={cn(iconSize, "text-danger")} />
                <span
                    className={cn(
                        "text-text-secondary text-sm",
                        variant === "card" && "max-w-md",
                    )}>
                    {message}
                </span>
                {onRetry && (
                    <Button
                        size={variant === "minimal" ? "icon-xs" : "sm"}
                        variant={
                            variant === "minimal" ? "cancel" : "primary-dark"
                        }
                        onClick={onRetry}>
                        {variant === "minimal" ? (
                            <RefreshCw className="size-3" />
                        ) : (
                            "Try again"
                        )}
                    </Button>
                )}
            </div>
        );
    },
);
ErrorCard.displayName = "ErrorCard";

export { ErrorCard, errorCardVariants };
