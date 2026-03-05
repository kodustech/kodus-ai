import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "src/core/utils/components";

import { Spinner } from "./spinner";

const inputVariants = cva(
    cn(
        "flex w-full items-center rounded-xl text-sm ring-1 transition",
        "bg-card-lv2 ring-card-lv3",
        "placeholder:text-text-placeholder/50",
        "textinput-focused:ring-3 textinput-focused:brightness-120",
        "textinput-invalid:border-danger",
        "textinput-focused-invalid:ring-danger",
        "textinput-hover:brightness-120",
        "textinput-disabled:cursor-not-allowed textinput-disabled:bg-text-placeholder/30 textinput-disabled:ring-text-placeholder/30",
        "textinput-loading:cursor-wait",
    ),
    {
        variants: {
            size: {
                md: "h-10 px-5",
                lg: "h-12 px-6",
            },
        },
        defaultVariants: {
            size: "lg",
        },
    },
);

interface InputProps
    extends
        Omit<React.InputHTMLAttributes<HTMLInputElement>, "size">,
        VariantProps<typeof inputVariants> {
    error?: unknown;
    loading?: boolean;
    leftIcon?: React.ReactNode;
    rightIcon?: React.ReactNode;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
    (
        {
            className,
            leftIcon: LeftIcon,
            rightIcon: RightIcon,
            disabled,
            loading,
            error,
            size,
            ...props
        },
        ref,
    ) => {
        return (
            <div className="relative min-w-0 flex-1">
                {LeftIcon && (
                    <div className="pointer-events-none absolute inset-y-0 left-4 z-1 flex items-center [&_svg]:size-5 [&_svg]:text-current">
                        {LeftIcon}
                    </div>
                )}

                <input
                    ref={ref}
                    disabled={disabled || loading}
                    className={cn(
                        inputVariants({ size }),
                        !!error && "ring-danger",
                        LeftIcon && "pl-12",
                        RightIcon && "pr-12",
                        className,
                    )}
                    {...props}
                    {...(!!error && { "data-invalid": true })}
                    {...(disabled && { "data-disabled": true })}
                    {...(loading && { "data-loading": true })}
                />

                {(loading || RightIcon) && (
                    <div className="pointer-events-[bounding-box] absolute inset-y-0 right-4 z-1 flex items-center [&_svg]:size-5 [&_svg]:text-current">
                        {loading ? (
                            <Spinner className="fill-card-lv3 text-primary-light" />
                        ) : (
                            RightIcon
                        )}
                    </div>
                )}
            </div>
        );
    },
);
Input.displayName = "Input";

export { Input };
