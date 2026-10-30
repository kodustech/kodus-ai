// Error boundaries must be Client Components
// global-error must include html and body tags
"use client";

import { useEffect } from "react";
import { DM_Sans } from "next/font/google";
import { Button } from "@components/ui/button";
import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { ArrowLeft, RefreshCw, XOctagonIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import "./globals.css";

const dm_sans = DM_Sans({
    subsets: ["latin"],
    preload: true,
});

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error("[Global Error]", error);
    }, [error]);
    return (
        <html lang="en">
            <head>
                <title>Something went wrong!</title>
            </head>

            <body
                className={cn(
                    "bg-background text-text-primary flex h-screen w-screen flex-col items-center justify-center overflow-hidden",
                    dm_sans.className,
                )}>
                <div className="flex w-md flex-col items-center justify-center gap-8">
                    <XOctagonIcon className="text-danger size-16" />

                    <Card className="w-full">
                        <CardHeader className="gap-4 px-8 py-8">
                            <CardTitle className="text-center">
                                Something went wrong!
                            </CardTitle>
                            <CardDescription className="text-center">
                                But don't worry! We're investigating any issues
                                actively and it should be fixed soon.
                            </CardDescription>
                        </CardHeader>
                    </Card>

                    <div className="flex gap-4">
                        <Button
                            size="sm"
                            variant="cancel"
                            leftIcon={<ArrowLeft />}
                            onClick={() => window.history.back()}>
                            Go back
                        </Button>

                        <Button
                            size="sm"
                            variant="primary-dark"
                            leftIcon={<RefreshCw />}
                            onClick={reset}>
                            Try again
                        </Button>

                        <Button
                            size="sm"
                            variant="primary"
                            onClick={() => {
                                window.location.href = "/";
                            }}>
                            Go to start page
                        </Button>
                    </div>
                </div>
            </body>
        </html>
    );
}
