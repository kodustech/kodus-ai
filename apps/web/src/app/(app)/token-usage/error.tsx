"use client";

import { useEffect } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { AlertCircle, RefreshCw } from "lucide-react";

// Route-scoped error boundary for Token Usage. The page fetches its data in a
// server component and intentionally does NOT swallow fetch failures, so a slow
// aggregation or a backend hiccup lands here — showing a real error + retry
// instead of a page full of misleading zeros.
export default function TokenUsageError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("[Token Usage Error]", error);
    }, [error]);

    return (
        <Page.Root>
            <Page.Header>
                <Page.Title>Token Usage</Page.Title>
            </Page.Header>

            <Page.Content>
                <div className="flex flex-col items-center justify-center gap-6 py-24">
                    <div className="bg-danger/10 rounded-full p-4">
                        <AlertCircle className="text-danger size-8" />
                    </div>

                    <div className="flex flex-col items-center gap-2 text-center">
                        <h2 className="text-xl font-semibold">
                            Couldn&apos;t load token usage
                        </h2>
                        <p className="text-text-secondary max-w-md text-sm">
                            The usage data failed to load — this is usually a
                            temporary issue while aggregating a large date
                            range. Try again, or narrow the date range.
                        </p>
                    </div>

                    <Button
                        size="lg"
                        variant="primary"
                        leftIcon={<RefreshCw />}
                        onClick={reset}>
                        Try again
                    </Button>
                </div>
            </Page.Content>
        </Page.Root>
    );
}
