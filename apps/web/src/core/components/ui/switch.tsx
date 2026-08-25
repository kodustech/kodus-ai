"use client";

import * as React from "react";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "src/core/utils/components";

import { Button } from "./button";
import { Spinner } from "./spinner";

const switchVariants = cva(
    cn(
        "aspect-video relative rounded-full px-0 py-0 justify-start transition-transform min-h-auto group",
        "switch-checked:bg-primary-light",
        "switch-unchecked:bg-text-placeholder/50",
        "switch-disabled:bg-text-placeholder/50 switch-disabled:cursor-not-allowed",
        "switch-focused:ring-3 switch-focused:ring-ring",
        "switch-hover:brightness-120",
        "switch-loading:cursor-wait!",
    ),
    {
        variants: {
            size: {
                sm: "h-5! *:*:size-4 switch-checked:*:*:translate-x-4 switch-unchecked:*:*:translate-x-0.5",
                md: "h-6! *:*:size-5 switch-checked:*:*:translate-x-5 switch-unchecked:*:*:translate-x-0.5",
            },
        },
        defaultVariants: {
            size: "md",
        },
    },
);

const Switch = React.forwardRef<
    React.ComponentRef<typeof SwitchPrimitives.Root>,
    React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
        loading?: boolean;
        decorative?: boolean;
    } & VariantProps<typeof switchVariants>
>(({ className, disabled, size, loading, ...props }, ref) => (
    <SwitchPrimitives.Root
        ref={ref}
        className={cn(
            switchVariants({ size }),
            props.decorative && "pointer-events-none",
            className,
        )}
        {...props}
        disabled={disabled || loading}
        {...(loading && { "data-loading": true })}
        asChild>
        <Button variant="primary" size="sm">
            <SwitchPrimitives.Thumb
                className={cn(
                    "bg-card-lv2 pointer-events-none relative rounded-full transition duration-300",
                    "group-switch-disabled:bg-text-placeholder/40",
                    "group-switch-loading:bg-transparent",
                    !loading && "shadow-lg",
                )}>
                {loading && (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <Spinner className="text-card-lv2 fill-card-lv2/20" />
                    </div>
                )}
            </SwitchPrimitives.Thumb>
        </Button>
    </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
