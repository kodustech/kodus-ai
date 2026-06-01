import { Dispatch, SetStateAction, useEffect, useMemo, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@components/ui/tabs";
import { toast } from "@components/ui/toaster/use-toast";
import {
    applyPendingKodyRules,
    convertPendingUpdatesToMemories as convertPendingUpdatesToMemoriesRequest,
    discardPendingKodyRules,
} from "@services/kodyRules/fetch";
import { KodyRule, KodyRuleRequestType } from "@services/kodyRules/types";
import { isCentralizedPrResponse } from "@services/parameters/types";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { pluralize } from "src/core/utils/string";

import { getCentralizedPrToastPayload } from "../_utils/centralized-pr-feedback";

type ModalTab = "new" | "updates";

const DiffRow = ({
    label,
    previous,
    next,
}: {
    label: string;
    previous?: string;
    next?: string;
}) => {
    const before = previous?.trim() || "—";
    const after = next?.trim() || "—";
    const changed = before !== after;

    if (!changed) {
        return null;
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="text-text-secondary text-xs font-semibold tracking-wide uppercase">
                {label}
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                <div className="bg-danger-background text-danger border-danger/30 rounded-md border px-3 py-2 text-sm whitespace-pre-wrap">
                    <span className="mr-2 font-semibold">-</span>
                    {before}
                </div>
                <div className="bg-success-background text-success border-success/30 rounded-md border px-3 py-2 text-sm whitespace-pre-wrap">
                    <span className="mr-2 font-semibold">+</span>
                    {after}
                </div>
            </div>
        </div>
    );
};

const EmptyStateCard = ({ message }: { message: string }) => (
    <Card className="bg-card-lv1">
        <CardContent className="text-text-secondary py-8 text-center text-sm">
            {message}
        </CardContent>
    </Card>
);

const mergeUniqueRulesByUuid = (
    currentRules: KodyRule[],
    incomingRules: KodyRule[],
) => {
    const mergedByUuid = new Map<string, KodyRule>();
    const rulesWithoutUuid: KodyRule[] = [];

    for (const rule of [...currentRules, ...incomingRules]) {
        if (!rule.uuid) {
            rulesWithoutUuid.push(rule);
            continue;
        }

        mergedByUuid.set(rule.uuid, rule);
    }

    return [...mergedByUuid.values(), ...rulesWithoutUuid];
};

const NewMemoryCard = ({
    memory,
    isSelected,
    canEdit,
    onToggle,
    onDiscard,
    onApply,
}: {
    memory: KodyRule;
    isSelected: boolean;
    canEdit: boolean;
    onToggle: (id: string) => void;
    onDiscard: (ids: string[]) => Promise<void>;
    onApply: (ids: string[]) => Promise<void>;
}) => {
    if (!memory.uuid) {
        return null;
    }

    return (
        <Card className="shrink-0">
            <Collapsible className="w-full">
                <CardHeader className="flex flex-row items-center gap-3 px-5 py-4">
                    <Checkbox
                        id={memory.uuid}
                        checked={isSelected}
                        disabled={!canEdit}
                        onClick={() => onToggle(memory.uuid!)}
                    />

                    <Label htmlFor={memory.uuid} className="flex-1">
                        {memory.title}
                    </Label>

                    <CollapsibleTrigger asChild>
                        <Button active size="icon-sm" variant="helper">
                            <CollapsibleIndicator />
                        </Button>
                    </CollapsibleTrigger>
                </CardHeader>

                <CollapsibleContent asChild className="pb-0">
                    <CardContent className="bg-card-lv1 flex flex-col gap-4 pt-4">
                        <Markdown>{memory.rule}</Markdown>

                        <div className="flex flex-wrap justify-end gap-2 pt-2">
                            <Button
                                size="sm"
                                variant="cancel"
                                disabled={!canEdit}
                                onClick={() => onDiscard([memory.uuid!])}>
                                Discard
                            </Button>

                            <Button
                                size="sm"
                                variant="primary"
                                disabled={!canEdit}
                                onClick={() => onApply([memory.uuid!])}>
                                Import memory
                            </Button>
                        </div>
                    </CardContent>
                </CollapsibleContent>
            </Collapsible>
        </Card>
    );
};

const UpdateMemoryCard = ({
    updateRule,
    targetMemory,
    isSelected,
    canEdit,
    onToggle,
    onConvert,
    onDiscard,
    onApply,
}: {
    updateRule: KodyRule;
    targetMemory?: KodyRule;
    isSelected: boolean;
    canEdit: boolean;
    onToggle: (id: string) => void;
    onConvert: (ids: string[]) => Promise<void>;
    onDiscard: (ids: string[]) => Promise<void>;
    onApply: (ids: string[]) => Promise<void>;
}) => {
    if (!updateRule.uuid) {
        return null;
    }

    return (
        <Card className="shrink-0">
            <Collapsible className="w-full">
                <CardHeader className="flex flex-row items-center gap-3 px-5 py-4">
                    <Checkbox
                        id={updateRule.uuid}
                        checked={isSelected}
                        disabled={!canEdit}
                        onClick={() => onToggle(updateRule.uuid!)}
                    />

                    <Label htmlFor={updateRule.uuid} className="flex-1">
                        {targetMemory?.title || "Unknown target memory"}
                    </Label>

                    <CollapsibleTrigger asChild>
                        <Button active size="icon-sm" variant="helper">
                            <CollapsibleIndicator />
                        </Button>
                    </CollapsibleTrigger>
                </CardHeader>

                <CollapsibleContent asChild className="pb-0">
                    <CardContent className="bg-card-lv1 flex flex-col gap-4 pt-4">
                        {!targetMemory ? (
                            <div className="text-warning text-sm">
                                Target memory was not found in the current list.
                                Approve carefully.
                            </div>
                        ) : (
                            <>
                                <DiffRow
                                    label="Title"
                                    previous={targetMemory.title}
                                    next={updateRule.title}
                                />
                                <DiffRow
                                    label="Rule"
                                    previous={targetMemory.rule}
                                    next={updateRule.rule}
                                />
                                <DiffRow
                                    label="Path"
                                    previous={targetMemory.path}
                                    next={updateRule.path}
                                />
                            </>
                        )}

                        <div className="flex flex-wrap justify-end gap-2 pt-2">
                            <Button
                                size="sm"
                                variant="helper"
                                disabled={!canEdit}
                                onClick={() => onConvert([updateRule.uuid!])}>
                                Convert to new memory
                            </Button>

                            <Button
                                size="sm"
                                variant="cancel"
                                disabled={!canEdit}
                                onClick={() => onDiscard([updateRule.uuid!])}>
                                Discard
                            </Button>

                            <Button
                                size="sm"
                                variant="primary"
                                disabled={!canEdit}
                                onClick={() => onApply([updateRule.uuid!])}>
                                Apply update
                            </Button>
                        </div>
                    </CardContent>
                </CollapsibleContent>
            </Collapsible>
        </Card>
    );
};

const PendingMemoriesFooter = ({
    activeTab,
    canEdit,
    hasChanges,
    selectedRuleIds,
    itemsInActiveTab,
    onSelectAll,
    onUnselectAll,
    onDiscard,
    onApply,
    onConvert,
}: {
    activeTab: ModalTab;
    canEdit: boolean;
    hasChanges: boolean;
    selectedRuleIds: string[];
    itemsInActiveTab: KodyRule[];
    onSelectAll: () => void;
    onUnselectAll: () => void;
    onDiscard: (ids: string[]) => Promise<void>;
    onApply: (ids: string[]) => Promise<void>;
    onConvert: (ids: string[]) => Promise<void>;
}) => (
    <DialogFooter className="flex flex-row justify-end gap-2">
        {itemsInActiveTab.length === 0 ? (
            <div />
        ) : (
            <div className="mr-auto flex items-center gap-4">
                {selectedRuleIds.length < itemsInActiveTab.length ? (
                    <Button
                        size="md"
                        variant="helper"
                        disabled={!canEdit}
                        onClick={onSelectAll}>
                        Select all
                    </Button>
                ) : (
                    <Button
                        size="md"
                        variant="helper"
                        disabled={!canEdit}
                        onClick={onUnselectAll}>
                        Unselect all
                    </Button>
                )}

                <span className="text-text-secondary text-sm">
                    <strong className="text-text-primary">
                        {selectedRuleIds.length}
                    </strong>{" "}
                    {pluralize(selectedRuleIds.length, {
                        singular: activeTab === "new" ? "memory" : "update",
                        plural: activeTab === "new" ? "memories" : "updates",
                    })}{" "}
                    selected
                </span>
            </div>
        )}

        <Button
            size="md"
            variant="cancel"
            onClick={() => magicModal.hide(hasChanges)}>
            Cancel
        </Button>

        {activeTab === "new" ? (
            <>
                <Button
                    size="md"
                    variant="cancel"
                    disabled={!canEdit || selectedRuleIds.length === 0}
                    onClick={() => onDiscard(selectedRuleIds)}>
                    Discard selected
                </Button>

                <Button
                    size="md"
                    variant="primary"
                    disabled={!canEdit || selectedRuleIds.length === 0}
                    onClick={() => onApply(selectedRuleIds)}>
                    Import selected
                </Button>
            </>
        ) : (
            <>
                <Button
                    size="md"
                    variant="helper"
                    disabled={!canEdit || selectedRuleIds.length === 0}
                    onClick={() => onConvert(selectedRuleIds)}>
                    Convert selected to new
                </Button>

                <Button
                    size="md"
                    variant="cancel"
                    disabled={!canEdit || selectedRuleIds.length === 0}
                    onClick={() => onDiscard(selectedRuleIds)}>
                    Discard selected
                </Button>

                <Button
                    size="md"
                    variant="primary"
                    disabled={!canEdit || selectedRuleIds.length === 0}
                    onClick={() => onApply(selectedRuleIds)}>
                    Apply selected
                </Button>
            </>
        )}
    </DialogFooter>
);

export const PendingMemoriesModal = ({
    pendingNewMemories,
    pendingUpdates,
    activeMemories,
    refreshRulesList,
}: {
    pendingNewMemories: KodyRule[];
    pendingUpdates: KodyRule[];
    activeMemories: KodyRule[];
    refreshRulesList: () => Promise<void>;
}) => {
    const [activeTab, setActiveTab] = useState<ModalTab>(
        pendingNewMemories.length > 0 ? "new" : "updates",
    );
    const [newMemories, setNewMemories] = useState<KodyRule[]>(() =>
        pendingNewMemories.filter(
            (rule) => rule.requestType !== KodyRuleRequestType.MEMORY_UPDATE,
        ),
    );
    const [updates, setUpdates] = useState<KodyRule[]>(() =>
        pendingUpdates.filter(
            (rule) => rule.requestType === KodyRuleRequestType.MEMORY_UPDATE,
        ),
    );
    const [hasChanges, setHasChanges] = useState(false);
    const [selectedNewIds, setSelectedNewIds] = useState<string[]>([]);
    const [selectedUpdateIds, setSelectedUpdateIds] = useState<string[]>([]);
    const { teamId } = useSelectedTeamId();
    const canEdit = usePermission(
        Action.Update,
        ResourceType.CodeReviewSettings,
    );

    const targetMemoryById = useMemo(
        () =>
            new Map(
                activeMemories
                    .filter((rule) => !!rule.uuid)
                    .map((rule) => [rule.uuid!, rule]),
            ),
        [activeMemories],
    );

    const selectedRuleIds =
        activeTab === "new" ? selectedNewIds : selectedUpdateIds;
    const itemsInActiveTab = activeTab === "new" ? newMemories : updates;

    useEffect(() => {
        if (activeTab === "new" && newMemories.length === 0 && updates.length) {
            setActiveTab("updates");
        }

        if (
            activeTab === "updates" &&
            updates.length === 0 &&
            newMemories.length
        ) {
            setActiveTab("new");
        }
    }, [activeTab, newMemories.length, updates.length]);

    const toggleSelection = (
        setter: Dispatch<SetStateAction<string[]>>,
        id: string,
    ) => {
        setter((selected) =>
            selected.includes(id)
                ? selected.filter((selectedId) => selectedId !== id)
                : [...selected, id],
        );
    };

    const applyPendingItems = async (ids: string[]) => {
        magicModal.lock();
        try {
            const response = await applyPendingKodyRules(teamId, ids);
            if (isCentralizedPrResponse(response)) {
                toast(
                    getCentralizedPrToastPayload(
                        response,
                        "Change proposed through centralized pull request.",
                    ),
                );
            }
            setHasChanges(true);
            setNewMemories((previous) =>
                previous.filter((rule) => !ids.includes(rule.uuid || "")),
            );
            setUpdates((previous) =>
                previous.filter((rule) => !ids.includes(rule.uuid || "")),
            );
            setSelectedNewIds((selected) =>
                selected.filter((id) => !ids.includes(id)),
            );
            setSelectedUpdateIds((selected) =>
                selected.filter((id) => !ids.includes(id)),
            );
        } catch (error) {
            console.error("Error applying pending items:", error);
        } finally {
            await refreshRulesList();
            magicModal.unlock();
        }
    };

    const discardPendingItems = async (ids: string[]) => {
        magicModal.lock();
        try {
            await discardPendingKodyRules(teamId, ids);
            setHasChanges(true);
            setNewMemories((previous) =>
                previous.filter((rule) => !ids.includes(rule.uuid || "")),
            );
            setUpdates((previous) =>
                previous.filter((rule) => !ids.includes(rule.uuid || "")),
            );
            setSelectedNewIds((selected) =>
                selected.filter((id) => !ids.includes(id)),
            );
            setSelectedUpdateIds((selected) =>
                selected.filter((id) => !ids.includes(id)),
            );
        } catch (error) {
            console.error("Error discarding pending items:", error);
        } finally {
            await refreshRulesList();
            magicModal.unlock();
        }
    };

    const convertPendingItemsToMemories = async (ids: string[]) => {
        magicModal.lock();
        try {
            const response = await convertPendingUpdatesToMemoriesRequest(
                teamId,
                ids,
            );

            if (isCentralizedPrResponse(response)) {
                toast(
                    getCentralizedPrToastPayload(
                        response,
                        "Change proposed through centralized pull request.",
                    ),
                );
            } else {
                const convertedMemories = response.filter(
                    (rule) =>
                        rule.requestType !== KodyRuleRequestType.MEMORY_UPDATE,
                );

                if (convertedMemories.length > 0) {
                    setNewMemories((currentMemories) =>
                        mergeUniqueRulesByUuid(
                            currentMemories,
                            convertedMemories,
                        ),
                    );
                }
            }

            setHasChanges(true);
            setUpdates((currentUpdates) =>
                currentUpdates.filter((rule) => !ids.includes(rule.uuid || "")),
            );
            setSelectedUpdateIds((selected) =>
                selected.filter((id) => !ids.includes(id)),
            );
        } catch (error) {
            console.error("Error converting pending items to memories:", error);
        } finally {
            await refreshRulesList();
            magicModal.unlock();
        }
    };

    const selectAllInActiveTab = () => {
        const allIds = itemsInActiveTab
            .map((rule) => rule.uuid)
            .filter((id): id is string => !!id);

        if (activeTab === "new") {
            setSelectedNewIds(allIds);
            return;
        }

        setSelectedUpdateIds(allIds);
    };

    const clearSelectionInActiveTab = () => {
        if (activeTab === "new") {
            setSelectedNewIds([]);
            return;
        }

        setSelectedUpdateIds([]);
    };

    return (
        <Dialog
            open
            onOpenChange={(open) => {
                if (!open) {
                    magicModal.hide(hasChanges);
                }
            }}>
            <DialogContent className="flex max-h-[80vh] max-w-(--breakpoint-lg) flex-col overflow-hidden">
                <DialogHeader>
                    <DialogTitle>Pending Memories</DialogTitle>
                    <DialogDescription>
                        Review new memories and update proposals before applying
                        them.
                    </DialogDescription>
                </DialogHeader>

                <Tabs
                    value={activeTab}
                    onValueChange={(v) => setActiveTab(v as ModalTab)}
                    className="flex min-h-0 flex-1 flex-col">
                    <TabsList>
                        <TabsTrigger value="new">
                            New ({newMemories.length})
                        </TabsTrigger>
                        <TabsTrigger value="updates">
                            Updates ({updates.length})
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="new" className="mt-3 h-[48vh]">
                        <div className="flex h-full w-full flex-col gap-2 overflow-y-auto pr-1">
                            {newMemories.length === 0 ? (
                                <EmptyStateCard message="No pending new memories." />
                            ) : (
                                newMemories.map((memory) => (
                                    <NewMemoryCard
                                        key={memory.uuid}
                                        memory={memory}
                                        isSelected={selectedNewIds.includes(
                                            memory.uuid!,
                                        )}
                                        canEdit={canEdit}
                                        onToggle={(id) =>
                                            toggleSelection(
                                                setSelectedNewIds,
                                                id,
                                            )
                                        }
                                        onDiscard={(ids) =>
                                            discardPendingItems(ids)
                                        }
                                        onApply={(ids) =>
                                            applyPendingItems(ids)
                                        }
                                    />
                                ))
                            )}
                        </div>
                    </TabsContent>

                    <TabsContent value="updates" className="mt-3 h-[48vh]">
                        <div className="flex h-full w-full flex-col gap-2 overflow-y-auto pr-1">
                            {updates.length === 0 ? (
                                <EmptyStateCard message="No pending memory updates." />
                            ) : (
                                updates.map((updateRule) => {
                                    const targetMemory =
                                        updateRule.targetRuleUuid
                                            ? targetMemoryById.get(
                                                  updateRule.targetRuleUuid,
                                              )
                                            : undefined;

                                    return (
                                        <UpdateMemoryCard
                                            key={updateRule.uuid}
                                            updateRule={updateRule}
                                            targetMemory={targetMemory}
                                            isSelected={selectedUpdateIds.includes(
                                                updateRule.uuid!,
                                            )}
                                            canEdit={canEdit}
                                            onToggle={(id) =>
                                                toggleSelection(
                                                    setSelectedUpdateIds,
                                                    id,
                                                )
                                            }
                                            onConvert={(ids) =>
                                                convertPendingItemsToMemories(
                                                    ids,
                                                )
                                            }
                                            onDiscard={(ids) =>
                                                discardPendingItems(ids)
                                            }
                                            onApply={(ids) =>
                                                applyPendingItems(ids)
                                            }
                                        />
                                    );
                                })
                            )}
                        </div>
                    </TabsContent>
                </Tabs>

                <PendingMemoriesFooter
                    activeTab={activeTab}
                    canEdit={canEdit}
                    hasChanges={hasChanges}
                    selectedRuleIds={selectedRuleIds}
                    itemsInActiveTab={itemsInActiveTab}
                    onSelectAll={selectAllInActiveTab}
                    onUnselectAll={clearSelectionInActiveTab}
                    onDiscard={discardPendingItems}
                    onApply={applyPendingItems}
                    onConvert={convertPendingItemsToMemories}
                />
            </DialogContent>
        </Dialog>
    );
};
