"use client";

import { useEffect } from "react";
import { Button } from "@components/ui/button";
import { AlertCircle, RefreshCw } from "lucide-react";

export default function RuntimeError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("[Kody Runtime Error]", error);
    }, [error]);

    return (
        <div className="flex min-h-[50vh] flex-1 flex-col items-center justify-center gap-6 p-6">
            <div className="bg-danger/10 rounded-full p-4">
                <AlertCircle className="text-danger size-8" />
            </div>
            <div className="flex flex-col items-center gap-2 text-center">
                <h2 className="text-xl font-semibold">
                    Failed to load Kody Runtime
                </h2>
                <p className="text-text-secondary max-w-md text-sm">
                    Something broke while rendering this screen. Try again.
                </p>
            </div>
            <Button
                size="md"
                variant="primary-dark"
                leftIcon={<RefreshCw />}
                onClick={reset}>
                Try again
            </Button>
        </div>
    );
}
