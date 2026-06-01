import { useState } from "react";
import { IssueSeverityLevelBadge } from "@components/system/issue-severity-level-badge";
import { Button } from "@components/ui/button";
import { Card, CardContent, CardHeader } from "@components/ui/card";
import { Checkbox } from "@components/ui/checkbox";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleIndicator,
    CollapsibleTrigger,
} from "@components/ui/collapsible";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { Label } from "@components/ui/label";
import { magicModal } from "@components/ui/magic-modal";
import { Markdown } from "@components/ui/markdown";
import { toast } from "@components/ui/toaster/use-toast";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import {
    applyPendingKodyRules,
    discardPendingKodyRules,
} from "@services/kodyRules/fetch";
import { KodyRule } from "@services/kodyRules/types";
import { isCentralizedPrResponse } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useQueryClient } from "@tanstack/react-query";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { pluralize } from "src/core/utils/string";

import { getCentralizedPrToastPayload } from "../_utils/centralized-pr-feedback";

const entityDescription = {
    rules: "Kody analyzed your past reviews and generated these rules:",
    memories: "Kody generated these memories based on your past interactions:",
};

export const PendingKodyRulesModal = ({
    pendingRules,
    entityLabel = "rules",
}: {
    pendingRules: KodyRule[];
    entityLabel?: "rules" | "memories";
}) => {
    const [selectedRuleIds, setSelectedRuleIds] = useState<string[]>([]);
    const { teamId } = useSelectedTeamId();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
    );

    const applyPendingItems = async (ids: string[], hide: boolean = true) => {
        magicModal.lock();
        try {
            const response = await applyPendingKodyRules(teamId, ids);

            if (isCentralizedPrResponse(response)) {
                toast(
                    getCentralizedPrToastPayload(
                        response,
                        `Proposed ${entityLabel} import through centralized pull request.`,
                    ),
                );
            }
        } catch (error) {
            console.error("Error applying pending items:", error);
        } finally {
            magicModal.hide(hide);
        }
    };

    const discardPendingItems = async (ids: string[], hide: boolean = true) => {
        magicModal.lock();
        try {
            await discardPendingKodyRules(teamId, ids);
        } catch (error) {
            console.error("Error discarding pending items:", error);
        } finally {
            magicModal.hide(hide);
        }
    };

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent className="max-h-[80vh] max-w-(--breakpoint-md)">
                <DialogHeader>
                    <DialogTitle>
                        New {entityLabel === "memories" ? "Memories" : "Rules"}{" "}
                        Ready
                    </DialogTitle>

                    <DialogDescription>
                        {entityDescription[entityLabel]}
                    </DialogDescription>
                </DialogHeader>

                <div className="flex w-full flex-col gap-2">
                    {pendingRules?.map((r) => (
                        <Card key={r.uuid}>
                            <Collapsible className="w-full">
                                <CardHeader className="flex flex-row items-center gap-3 px-5 py-4">
                                    <Checkbox
                                        id={r.uuid}
                                        checked={selectedRuleIds.includes(
                                            r.uuid!,
                                        )}
                                        disabled={!canEdit}
                                        onClick={() => {
                                            setSelectedRuleIds((selected) =>
                                                selected.includes(r.uuid!)
                                                    ? selected.filter(
                                                          (id) => id !== r.uuid,
                                                      )
                                                    : [...selected, r.uuid!],
                                            );
                                        }}
                                    />

                                    <Label htmlFor={r.uuid} className="flex-1">
                                        {r.title}
                                    </Label>

                                    <div className="flex items-center gap-3">
                                        <IssueSeverityLevelBadge
                                            severity={r.severity}
                                        />

                                        <CollapsibleTrigger asChild>
                                            <Button
                                                active
                                                size="icon-sm"
                                                variant="helper">
                                                <CollapsibleIndicator />
                                            </Button>
                                        </CollapsibleTrigger>
                                    </div>
                                </CardHeader>

                                <CollapsibleContent asChild className="pb-0">
                                    <CardContent className="bg-card-lv1 flex flex-col gap-5 pt-4">
                                        <Markdown>{r.rule}</Markdown>

                                        <div className="flex flex-wrap justify-end gap-2">
                                            <Button
                                                size="sm"
                                                variant="cancel"
                                                disabled={!canEdit}
                                                onClick={() =>
                                                    r.uuid &&
                                                    discardPendingItems(
                                                        [r.uuid],
                                                        false,
                                                    )
                                                }>
                                                Discard
                                            </Button>

                                            <Button
                                                size="sm"
                                                variant="primary"
                                                disabled={!canEdit}
                                                onClick={() =>
                                                    r.uuid &&
                                                    applyPendingItems(
                                                        [r.uuid],
                                                        false,
                                                    )
                                                }>
                                                Import
                                            </Button>
                                        </div>
                                    </CardContent>
                                </CollapsibleContent>
                            </Collapsible>
                        </Card>
                    ))}
                </div>

                <DialogFooter className="flex flex-row justify-end gap-2">
                    {pendingRules.length === 0 ? (
                        <div />
                    ) : (
                        <div className="mr-auto flex items-center gap-4">
                            {selectedRuleIds.length < pendingRules.length ? (
                                <Button
                                    size="md"
                                    variant="helper"
                                    disabled={!canEdit}
                                    onClick={() =>
                                        setSelectedRuleIds(
                                            pendingRules.map((r) => r.uuid!),
                                        )
                                    }>
                                    Select all
                                </Button>
                            ) : (
                                <Button
                                    size="md"
                                    variant="helper"
                                    disabled={!canEdit}
                                    onClick={() => setSelectedRuleIds([])}>
                                    Unselect all
                                </Button>
                            )}

                            <span className="text-text-secondary text-sm">
                                <strong className="text-text-primary">
                                    {selectedRuleIds.length}
                                </strong>{" "}
                                {pluralize(selectedRuleIds.length, {
                                    plural: entityLabel,
                                    singular:
                                        entityLabel === "memories"
                                            ? "memory"
                                            : "rule",
                                })}{" "}
                                selected
                            </span>
                        </div>
                    )}

                    <Button
                        size="md"
                        variant="cancel"
                        onClick={magicModal.hide}>
                        Cancel
                    </Button>

                    <Button
                        size="md"
                        variant="cancel"
                        disabled={!canEdit || selectedRuleIds.length === 0}
                        onClick={() => discardPendingItems(selectedRuleIds)}>
                        Discard selected
                    </Button>

                    <Button
                        size="md"
                        variant="primary"
                        disabled={!canEdit || selectedRuleIds.length === 0}
                        onClick={() => applyPendingItems(selectedRuleIds)}>
                        Import selected
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};
