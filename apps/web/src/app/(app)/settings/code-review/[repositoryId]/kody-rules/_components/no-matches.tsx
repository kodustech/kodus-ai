"use client";

import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { SearchX } from "lucide-react";

type KodyRulesNoMatchesProps = {
    entityLabel?: "rule" | "memory";
    onClearFilters: () => void;
};

// Shown when there ARE rules in the system but the active filters narrowed
// the list down to nothing. Distinct from KodyRulesEmptyState (no rules at
// all, plus discovery suggestions) so users do not get bumped back into
// onboarding-style content when they were just over-filtering.
export const KodyRulesNoMatches = ({
    entityLabel = "rule",
    onClearFilters,
}: KodyRulesNoMatchesProps) => {
    const plural = entityLabel === "memory" ? "memories" : "rules";

    return (
        <div className="bg-card-lv2 border-card-lv3 mt-2 flex flex-col items-center gap-3 rounded-xl border p-10 text-center">
            <div className="bg-card-lv3 flex size-12 items-center justify-center rounded-full">
                <SearchX className="text-text-secondary size-6" aria-hidden />
            </div>
            <Heading variant="h3" className="text-base">
                No {plural} match these filters
            </Heading>
            <p className="text-text-secondary max-w-sm text-sm">
                Adjust the search query or remove some filters to see more
                results.
            </p>
            <Button size="sm" variant="primary" onClick={onClearFilters}>
                Clear all filters
            </Button>
        </div>
    );
};
