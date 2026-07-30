"use client";

import {
    type KodyRule,
    type KodyRuleWithInheritanceDetails,
} from "@services/kodyRules/types";

import { KodyRuleItem } from "./item";

type KodyRulesListProps = {
    rules: KodyRule[];
    tab: "review-rules" | "memories";
    onAnyChange: () => void;
    showSuggestionsButton?: boolean;
    /** Optional bulk-selection wiring. When omitted the list renders
     *  without checkboxes. */
    bulkSelection?: {
        selection: ReadonlySet<string>;
        onToggle: (ruleId: string) => void;
        isEligible: (rule: KodyRuleWithInheritanceDetails) => boolean;
    };
    /** Repo's `ideRulesSyncEnabled`; forwarded to each row's OriginBadge. */
    syncEnabledForRepo?: boolean;
};

export const KodyRulesList = ({
    rules,
    tab,
    onAnyChange,
    bulkSelection,
    syncEnabledForRepo,
}: KodyRulesListProps) => {
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
            {rules.map((rule) => {
                const selection =
                    bulkSelection && rule.uuid
                        ? {
                              isSelected: bulkSelection.selection.has(
                                  rule.uuid,
                              ),
                              eligible: bulkSelection.isEligible(
                                  rule as KodyRuleWithInheritanceDetails,
                              ),
                              onToggle: () =>
                                  bulkSelection.onToggle(rule.uuid as string),
                          }
                        : undefined;

                return (
                    <KodyRuleItem
                        key={rule.uuid}
                        rule={rule}
                        onAnyChange={onAnyChange}
                        showSuggestionsButton={tab === "review-rules"}
                        selection={selection}
                        syncEnabledForRepo={syncEnabledForRepo}
                    />
                );
            })}
        </div>
    );
};
