"use client";

import { useEffect } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { AlertCircle, RefreshCw } from "lucide-react";

export default function SettingsError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("[Settings Error]", error);
    }, [error]);

    return (
        <Page.Root>
            <Page.Content className="flex min-h-[50vh] flex-col items-center justify-center gap-6">
                <div className="bg-danger/10 rounded-full p-4">
                    <AlertCircle className="text-danger size-8" />
                </div>

                <div className="flex flex-col items-center gap-2 text-center">
                    <h2 className="text-xl font-semibold">
                        Failed to load settings
                    </h2>
                    <p className="text-text-secondary max-w-md text-sm">
                        We encountered an error while loading the settings page.
                        This might be a temporary issue.
                    </p>
                </div>

                <Button
                    size="lg"
                    variant="primary"
                    leftIcon={<RefreshCw />}
                    onClick={reset}>
                    Try again
                </Button>
            </Page.Content>
        </Page.Root>
    );
}
