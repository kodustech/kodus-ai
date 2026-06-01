"use client";

import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Skeleton } from "@components/ui/skeleton";

// Renders a small grid of placeholder cards while the rules list is loading.
// Matches the real KodyRuleItem layout closely so the page does not jump
// when data arrives.
export const KodyRulesListSkeleton = ({ count = 4 }: { count?: number }) => {
    return (
        <div
            className="grid grid-cols-2 gap-2"
            role="status"
            aria-live="polite"
            aria-label="Loading rules">
            {Array.from({ length: count }).map((_, i) => (
                <Card key={i}>
                    <CardHeader className="flex-row items-start justify-between gap-10">
                        <div className="flex flex-col gap-2">
                            <div className="flex gap-2">
                                <Skeleton className="h-5 w-16" />
                                <Skeleton className="h-5 w-20" />
                            </div>
                            <Skeleton className="h-5 w-3/4" />
                        </div>
                        <div className="flex gap-2">
                            <Skeleton className="size-9 rounded" />
                            <Skeleton className="size-9 rounded" />
                        </div>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-5/6" />
                        <Skeleton className="h-4 w-2/3" />
                    </CardContent>
                </Card>
            ))}
        </div>
    );
};
