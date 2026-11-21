import type { ReactNode } from "react";
import { errorStatus } from "@services/runtime/model/errors";
import { cn } from "src/core/utils/components";

/** What a Runtime screen shows when there is nothing yet. */
export const RuntimeEmptyState = ({
    title,
    children,
    className,
    role,
}: {
    title: string;
    children?: ReactNode;
    className?: string;
    role?: "alert" | "status";
}) => (
    <div
        role={role}
        className={cn(
            "bg-card-lv1 flex flex-col gap-1 rounded-xl px-6 py-8",
            className,
        )}>
        <p className="text-text-primary text-sm font-semibold">{title}</p>
        {children && (
            <div className="text-text-secondary max-w-2xl text-sm">
                {children}
            </div>
        )}
    </div>
);

const reasonOf = (error: unknown) => {
    switch (errorStatus(error)) {
        case 403:
            return "You do not have access to this.";
        case 404:
            return "The Runtime API did not find this route. It may not be enabled on this server.";
        case 429:
            return "Too many requests for a moment.";
        default:
            return "The API answered with an error.";
    }
};

/**
 * A failed load. A 404 on a list is shown here, not as "nothing yet": an
 * empty list is an empty array, a 404 is a missing or denied route.
 */
export const RuntimeErrorState = ({
    what,
    error,
    onRetry,
}: {
    what: string;
    error?: unknown;
    onRetry?: () => void;
}) => (
    <RuntimeEmptyState title={`Couldn't load ${what}`} role="alert">
        <p>
            {reasonOf(error)}{" "}
            {onRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    className="text-primary-light underline-offset-2 hover:underline">
                    Try again
                </button>
            )}
        </p>
    </RuntimeEmptyState>
);
