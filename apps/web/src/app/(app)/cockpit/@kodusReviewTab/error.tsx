"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { CardContent } from "@components/ui/card";

export default function ErrorPage({
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    const router = useRouter();

    return (
        <CardContent className="text-text-secondary flex h-64 w-full flex-col items-center justify-center gap-2 text-center text-sm">
            <span className="w-60">
                It looks like we couldn't fetch the review analytics data.
            </span>
            <Button
                size="xs"
                variant="primary-dark"
                onClick={() => {
                    startTransition(() => {
                        reset();
                        router.refresh();
                    });
                }}>
                Try again
            </Button>
        </CardContent>
    );
}
