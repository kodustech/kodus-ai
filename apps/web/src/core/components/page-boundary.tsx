"use client";

import { ReactNode, Suspense } from "react";
import { QueryErrorResetBoundary } from "@tanstack/react-query";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";

import { ErrorCard } from "./ui/error-card";
import { Skeleton } from "./ui/skeleton";

/**
 * PageBoundary - Standard wrapper for pages/components that fetch data
 *
 * Combines:
 * - QueryErrorResetBoundary: Resets React Query errors on retry
 * - ErrorBoundary: Catches errors and shows error UI
 * - Suspense: Shows loading UI while data is being fetched
 *
 * Usage:
 * ```tsx
 * <PageBoundary>
 *   <MyPageThatFetchesData />
 * </PageBoundary>
 *
 * // With custom loading/error:
 * <PageBoundary
 *   loading={<CustomSkeleton />}
 *   errorVariant="card"
 * >
 *   <MyPageThatFetchesData />
 * </PageBoundary>
 *
 * // Silent errors (for non-critical UI):
 * <PageBoundary errorFallback={null}>
 *   <OptionalWidget />
 * </PageBoundary>
 * ```
 */

interface PageBoundaryProps {
    children: ReactNode;
    /** Loading fallback - shown while Suspense is pending */
    loading?: ReactNode;
    /** Error fallback - shown when an error occurs. Set to null to render nothing on error */
    errorFallback?: ReactNode | null;
    /** Variant for the default ErrorCard */
    errorVariant?: "card" | "inline" | "minimal";
    /** Custom error message */
    errorMessage?: string;
    /** Callback when an error occurs */
    onError?: (error: Error) => void;
}

export function PageBoundary({
    children,
    loading,
    errorFallback,
    errorVariant = "inline",
    errorMessage,
    onError,
}: PageBoundaryProps) {
    const defaultLoading = loading ?? <DefaultLoadingSkeleton />;

    return (
        <QueryErrorResetBoundary>
            {({ reset }) => (
                <ErrorBoundary
                    onReset={reset}
                    onError={onError}
                    fallbackRender={(props) => (
                        <ErrorFallback
                            {...props}
                            customFallback={errorFallback}
                            variant={errorVariant}
                            message={errorMessage}
                        />
                    )}>
                    <Suspense fallback={defaultLoading}>{children}</Suspense>
                </ErrorBoundary>
            )}
        </QueryErrorResetBoundary>
    );
}

function ErrorFallback({
    error,
    resetErrorBoundary,
    customFallback,
    variant,
    message,
}: FallbackProps & {
    customFallback?: ReactNode | null;
    variant: "card" | "inline" | "minimal";
    message?: string;
}) {
    // Allow explicitly hiding errors
    if (customFallback === null) {
        return null;
    }

    // Use custom fallback if provided
    if (customFallback !== undefined) {
        return <>{customFallback}</>;
    }

    // Default: show ErrorCard with retry
    return (
        <ErrorCard
            variant={variant}
            message={message ?? "Failed to load data. Please try again."}
            onRetry={resetErrorBoundary}
        />
    );
}

function DefaultLoadingSkeleton() {
    return (
        <div className="flex flex-col gap-4 p-4">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-32 w-full" />
        </div>
    );
}

// Re-export QueryBoundary as alias for backwards compatibility
export { PageBoundary as QueryBoundary };
