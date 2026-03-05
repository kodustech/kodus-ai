import * as React from "react";
import { cn } from "src/core/utils/components";

import { Spinner } from "./spinner";

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
    error?: unknown;
    loading?: boolean;
    leftIcon?: React.ReactNode;
    rightIcon?: React.ReactNode;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
    (
        {
            className,
            leftIcon: LeftIcon,
            rightIcon: RightIcon,
            disabled,
            loading,
            error,
            ...props
        },
        ref,
    ) => {
        return (
            <div className="relative">
                {LeftIcon && (
                    <div className="pointer-events-none absolute inset-y-0 left-4 z-1 flex py-4 [&_svg]:size-5 [&_svg]:text-current">
                        {LeftIcon}
                    </div>
                )}
                <textarea
                    ref={ref}
                    disabled={disabled || loading}
                    className={cn(
                        "resize-x-none flex min-h-20 w-full items-center rounded-xl px-6 py-4 text-sm ring-1 transition",
                        "bg-card-lv2 ring-card-lv3",
                        "placeholder:text-text-placeholder/50",
                        "textinput-focused:ring-3 textinput-focused:brightness-120",
                        "textinput-invalid:border-danger",
                        "textinput-focused-invalid:ring-danger",
                        "textinput-hover:brightness-120",
                        "textinput-disabled:cursor-not-allowed textinput-disabled:bg-text-placeholder/30 textinput-disabled:ring-text-placeholder/30 textinput-disabled:resize-none",
                        "textinput-loading:cursor-wait",
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
                    <div className="pointer-events-none absolute inset-y-0 right-4 z-1 flex py-4 [&_svg]:size-5 [&_svg]:text-current">
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
Textarea.displayName = "Textarea";

export { Textarea };
