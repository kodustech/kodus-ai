"use client";

import { type KodyRule } from "@services/kodyRules/types";
import { useFeatureFlags } from "src/app/(app)/settings/_components/context";

import { KodyRuleItem } from "./item";

type KodyRulesListProps = {
    rules: KodyRule[];
    tab: "review-rules" | "memories";
    onAnyChange: () => void;
    showSuggestionsButton?: boolean;
};

export const KodyRulesList = ({
    rules,
    tab,
    onAnyChange,
}: KodyRulesListProps) => {
    const { kodyRuleSuggestions } = useFeatureFlags();
    const entityLabel = tab === "memories" ? "memories" : "rules";

    if (rules.length === 0) {
        return (
            <div className="text-text-secondary flex flex-col items-center gap-2 py-20 text-sm">
                No {entityLabel} found with your current filters.
            </div>
        );
    }

    return (
        <div className="grid grid-cols-2 gap-2">
            {rules.map((rule) => (
                <KodyRuleItem
                    key={rule.uuid}
                    rule={rule}
                    tab={tab}
                    onAnyChange={onAnyChange}
                    showSuggestionsButton={
                        tab === "review-rules" && kodyRuleSuggestions
                    }
                />
            ))}
        </div>
    );
};
