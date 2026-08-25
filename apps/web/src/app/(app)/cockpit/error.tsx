"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";

/**
 * Boundary for the Cockpit shell itself.
 *
 * Each analytics slot already has its own `error.tsx`, so a single failing
 * query costs one card and the rest of the dashboard keeps rendering. Nothing
 * caught a throw in the shell around them — the layout, the filter bar, the
 * tabs — which fell through to the app-level boundary and took the whole page
 * with it, filters and all.
 *
 * The copy names which surface failed. A leader looking at a bare "something
 * went wrong" cannot tell whether the dashboard is broken or the review
 * practice it reports on is, and those are very different problems.
 */
export default function CockpitError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const router = useRouter();

    return (
        <div className="text-text-secondary flex min-h-100 w-full flex-col items-center justify-center gap-3 p-10 text-center text-sm">
            <p className="text-text-primary text-base font-semibold">
                The Cockpit couldn&apos;t load
            </p>

            <p className="max-w-100">
                Your metrics are safe — this is the dashboard failing to render,
                not the data behind it. Reloading usually resolves it.
            </p>

            {error.digest && (
                <p className="text-text-tertiary text-2xs font-mono">
                    Reference: {error.digest}
                </p>
            )}

            <Button
                size="sm"
                variant="primary-dark"
                onClick={() => {
                    startTransition(() => {
                        reset();
                        router.refresh();
                    });
                }}>
                Try again
            </Button>
        </div>
    );
}
