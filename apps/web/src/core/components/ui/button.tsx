"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "src/core/utils/components";

import { Spinner } from "./spinner";

const buttonVariants = cva(
    cn(
        "inline-flex overflow-hidden select-none relative items-center justify-center transition h-auto",
        "rounded-xl font-semibold transition text-start shrink-0 text-sm w-fit",
        "bg-(--button-background) text-(--button-foreground) [&_svg]:size-(--icon-size) ring-card-lv3",
        "[&[aria-haspopup=dialog]]:ring-1",
        "button-focused:ring-3!",
        "button-hover:brightness-120 button-active:brightness-120",
        "cursor-pointer",
        "button-loading:cursor-wait",
        "button-disabled:cursor-not-allowed group-disabled/link:cursor-not-allowed",
        "group-disabled/link:[&:hover]:brightness-100!",
        "group-button-focused/link:ring-3!",
    ),
    {
        variants: {
            variant: {
                "primary": cn(
                    "[--button-background:var(--color-primary-light)] [--button-foreground:var(--color-primary-dark)]",
                    "button-disabled:bg-text-placeholder/30 button-disabled:text-text-placeholder",
                    "group-disabled/link:bg-text-placeholder/30 group-disabled/link:text-text-placeholder",
                ),

                "primary-dark": cn(
                    "[--button-background:var(--color-primary-dark)] [--button-foreground:var(--color-primary-light)]",
                    "button-disabled:bg-text-placeholder/30 button-disabled:text-text-placeholder",
                    "group-disabled/link:bg-text-placeholder/30 group-disabled/link:text-text-placeholder",
                ),

                "secondary": cn(
                    "[--button-background:var(--color-secondary-dark)] [--button-foreground:var(--color-primary-light)]",
                    "button-disabled:bg-text-placeholder/30 button-disabled:text-text-placeholder",
                    "group-disabled/link:bg-text-placeholder/30 group-disabled/link:text-text-placeholder",
                ),

                "helper": cn(
                    "[--button-background:var(--color-card-lv2)] [--button-foreground:var(--color-text-secondary)]",
                    "button-disabled:bg-text-placeholder/30 button-disabled:text-text-placeholder",
                    "group-disabled/link:bg-text-placeholder/30 group-disabled/link:text-text-placeholder",
                ),

                "tertiary": cn(
                    "[--button-background:var(--color-tertiary-dark)] [--button-foreground:var(--color-tertiary-light)]",
                    "button-disabled:bg-text-placeholder/30 button-disabled:text-text-placeholder",
                    "group-disabled/link:bg-text-placeholder/30 group-disabled/link:text-text-placeholder",
                ),

                "cancel": cn(
                    "[--button-foreground:var(--color-text-tertiary)] button-hover:[--button-foreground:var(--color-text-primary)] button-active:[--button-foreground:var(--color-text-primary)]",
                    "button-disabled:text-placeholder/30",
                    "group-disabled/link:text-placeholder/30",
                ),

                "success": cn(
                    "[--button-background:#152120] [--button-foreground:#42BE65]",
                    "button-disabled:bg-text-placeholder/30 button-disabled:text-text-placeholder",
                    "group-disabled/link:bg-text-placeholder/30 group-disabled/link:text-text-placeholder",
                ),

                "in-progress": cn(
                    "[--button-background:#171D30] [--button-foreground:#5C97FF]",
                    "button-disabled:bg-text-placeholder/30 button-disabled:text-text-placeholder",
                    "group-disabled/link:bg-text-placeholder/30 group-disabled/link:text-text-placeholder",
                ),

                "error": cn(
                    "[--button-background:#271720] [--button-foreground:#FA5867]",
                    "button-disabled:bg-text-placeholder/30 button-disabled:text-text-placeholder",
                    "group-disabled/link:bg-text-placeholder/30 group-disabled/link:text-text-placeholder",
                ),
            },
            size: {
                "xs": "min-h-7 [--icon-size:calc(var(--spacing)*4)] rounded-full text-xs px-3.5 py-1.5 gap-1.5",
                "sm": "min-h-8 [--icon-size:calc(var(--spacing)*4)] px-4 py-2 gap-2",
                "md": "min-h-10 [--icon-size:calc(var(--spacing)*4.5)] px-5 py-2.5 gap-3",
                "lg": "min-h-12 [--icon-size:calc(var(--spacing)*5)] px-6 py-3 gap-3",
                "icon-xs":
                    "size-7 [--icon-size:calc(var(--spacing)*4)] rounded-full",
                "icon-sm": "size-8 [--icon-size:calc(var(--spacing)*4)]",
                "icon-md": "size-10 [--icon-size:calc(var(--spacing)*4.5)]",
                "icon-lg": "size-12 [--icon-size:calc(var(--spacing)*5)]",
            },
        },
        defaultVariants: {
            // variant: "primary",
            // size: "md",
        },
    },
);

interface ButtonProps
    extends
        React.ButtonHTMLAttributes<HTMLButtonElement>,
        Required<VariantProps<typeof buttonVariants>> {
    loading?: boolean;
    active?: boolean;
    decorative?: boolean;
    leftIcon?: React.ReactNode;
    rightIcon?: React.ReactNode;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    (props, ref) => {
        const {
            variant,
            size,
            disabled,
            decorative,
            leftIcon: LeftIcon,
            rightIcon: RightIcon,
            loading,
            active,
            ...otherProps
        } = props;

        const Component = decorative ? "span" : "button";

        return (
            <Component
                {...(active && { "data-active": true })}
                {...(loading && { "data-loading": true })}
                {...(disabled && { "data-disabled": true })}
                {...(decorative && { "data-decorative": true })}
                {...otherProps}
                ref={ref}
                disabled={disabled || loading}
                className={cn(
                    buttonVariants({ variant, size }),
                    props.className,
                )}
                onClick={(ev) => {
                    if (disabled) return ev.preventDefault();
                    props.onClick?.(ev);
                }}>
                {loading && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-[inherit] backdrop-blur-3xl">
                        <Spinner className="size-(--icon-size)! fill-(--button-foreground)/10 text-(--button-foreground)" />
                    </div>
                )}

                <div className="contents">
                    {LeftIcon}
                    {props.children}
                    {RightIcon}
                </div>
            </Component>
        );
    },
);

Button.displayName = "Button";

export { Button, buttonVariants };
