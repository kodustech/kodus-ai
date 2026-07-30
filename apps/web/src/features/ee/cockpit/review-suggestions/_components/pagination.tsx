"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@components/ui/button";

export const Pagination = ({
    total,
    page,
    pageSize,
}: {
    total: number;
    page: number;
    pageSize: number;
}) => {
    const router = useRouter();
    const searchParams = useSearchParams();
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    if (totalPages === 1) return null;

    const goTo = (target: number) => {
        const next = new URLSearchParams(searchParams.toString());
        next.set("page", String(target));
        router.push(`/review-suggestions?${next.toString()}`);
    };

    return (
        <div className="text-text-tertiary flex items-center justify-between text-xs">
            <span>
                Page {page} of {totalPages} · {total} suggestions
            </span>
            <div className="flex gap-2">
                <Button
                    size="xs"
                    variant="primary-dark"
                    disabled={page <= 1}
                    onClick={() => goTo(page - 1)}>
                    ← Previous
                </Button>
                <Button
                    size="xs"
                    variant="primary-dark"
                    disabled={page >= totalPages}
                    onClick={() => goTo(page + 1)}>
                    Next →
                </Button>
            </div>
        </div>
    );
};
