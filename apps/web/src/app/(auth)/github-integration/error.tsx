"use client";

import { useEffect } from "react";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@components/ui/card";
import { AlertCircle, RefreshCw } from "lucide-react";

export default function GithubIntegrationError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("[GithubIntegration Error]", error);
    }, [error]);

    return (
        <div className="flex h-full w-full items-center justify-center">
            <Card className="w-lg">
                <CardHeader className="flex flex-row items-center gap-3">
                    <div className="bg-danger/10 rounded-full p-2">
                        <AlertCircle className="text-danger size-5" />
                    </div>
                    <CardTitle>The GitHub integration could not be loaded.</CardTitle>
                </CardHeader>

                <CardContent>
                    <p className="text-text-secondary text-sm">
                        We encountered an error while resolving the installation. This
                        might be a temporary issue. Try again, or contact support if it
                        persists.
                    </p>
                </CardContent>

                <CardFooter className="justify-end">
                    <Button
                        size="md"
                        variant="primary"
                        leftIcon={<RefreshCw />}
                        onClick={reset}>
                        Try again
                    </Button>
                </CardFooter>
            </Card>
        </div>
    );
}
