"use client";

import { useEffect } from "react";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { AlertCircle, RefreshCw } from "lucide-react";

export default function SetupError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("[Setup Error]", error);
    }, [error]);

    return (
        <Page.Root className="mx-auto flex h-full min-h-[calc(100vh-4rem)] w-full flex-row overflow-hidden p-6">
            <div className="flex flex-1 flex-col items-center justify-center gap-6">
                <div className="bg-danger/10 rounded-full p-4">
                    <AlertCircle className="text-danger size-8" />
                </div>

                <div className="flex flex-col items-center gap-2 text-center">
                    <Heading variant="h2">Something went wrong</Heading>
                    <p className="text-text-secondary max-w-md text-sm">
                        We encountered an error while loading this page. This
                        might be a temporary issue.
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
        </Page.Root>
    );
}
