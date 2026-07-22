"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { Section } from "@components/ui/section";
import { toast } from "@components/ui/toaster/use-toast";
import { useAsyncAction } from "@hooks/use-async-action";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { SelectRepositories } from "@components/system/select-repositories";
import { useGetRepositories } from "@services/codeManagement/hooks";
import type { Repository } from "@services/codeManagement/types";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import {
    resyncGlobalRules,
    setGlobalSourceRepositories,
} from "@services/kodyRules/fetch";
import { useSuspenseGlobalRulesSourceRepositories } from "@services/kodyRules/hooks";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { Trash2 } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

/**
 * Configuration control (global scope only) that lets the user pick one or more
 * connected repositories as sources of GLOBAL Kody Rules. Their rule files are
 * scanned and imported into the org-wide scope by the same engine that syncs
 * per-repo rules.
 */
export const GlobalRulesSourceSetting = () => {
    const { teamId } = useSelectedTeamId();
    const { invalidateQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();
    const canEdit = usePermission(Action.Create, ResourceType.KodyRules);

    const savedSources = useSuspenseGlobalRulesSourceRepositories({ teamId });
    const { data: repositories = [] } = useGetRepositories(teamId);

    const [pickerOpen, setPickerOpen] = useState(false);
    const [selected, setSelected] = useState<Repository[]>([]);

    // Seed the local selection from the persisted sources once the repository
    // list is available (the picker compares by id, so we resolve full
    // Repository objects from the fetched list).
    useEffect(() => {
        if (!repositories.length) return;
        const savedIds = new Set(savedSources.map((r) => String(r.id)));
        setSelected(
            repositories.filter((r) => savedIds.has(String(r.id))),
        );
    }, [repositories, savedSources]);

    const isDirty = useMemo(() => {
        const a = new Set(selected.map((r) => String(r.id)));
        const b = new Set(savedSources.map((r) => String(r.id)));
        if (a.size !== b.size) return true;
        for (const id of a) if (!b.has(id)) return true;
        return false;
    }, [selected, savedSources]);

    const refreshSources = () =>
        invalidateQueries({
            queryKey: generateQueryKey(
                KODY_RULES_PATHS.GLOBAL_SOURCE_REPOSITORIES,
                { params: { teamId } },
            ),
        });

    const [handleSave, { loading: isSaving }] = useAsyncAction(async () => {
        try {
            await setGlobalSourceRepositories({
                teamId,
                repositories: selected.map((r) => ({
                    id: String(r.id),
                    name: r.name,
                    fullName: r.full_name,
                })),
            });
            await refreshSources();
            toast({
                variant: "success",
                title: "Global rule sources updated",
                description:
                    "Rules from the selected repositories are being imported in the background.",
            });
        } catch {
            toast({
                variant: "danger",
                title: "Could not update global rule sources",
            });
        }
    });

    const [handleResync, { loading: isResyncing }] = useAsyncAction(async () => {
        try {
            await resyncGlobalRules({ teamId });
            toast({
                variant: "success",
                title: "Resync started",
                description:
                    "Re-scanning the selected repositories for global rules.",
            });
        } catch {
            toast({ variant: "danger", title: "Could not start resync" });
        }
    });

    const removeFromSelection = (id: string) =>
        setSelected((prev) => prev.filter((r) => String(r.id) !== String(id)));

    return (
        <Card>
            <CardHeader>
                <Section.Root>
                    <Section.Header>
                        <Section.Title>Global rule sources</Section.Title>
                        <Section.Description>
                            Select connected repositories to import their rule
                            files as global Kody Rules. Global rules apply to
                            every repository during code review.
                        </Section.Description>
                    </Section.Header>

                    <Section.Content className="flex flex-col gap-4">
                        <SelectRepositories
                            id="global-rules-source-picker"
                            open={pickerOpen}
                            onOpenChange={setPickerOpen}
                            selectedRepositories={selected}
                            onChangeSelectedRepositories={setSelected}
                            teamId={teamId}
                            // Only repositories connected in git settings (those
                            // with a webhook) can be global sources, so their
                            // rules stay updated via the PR-merge trigger.
                            filterRepository={(r) => r.selected === true}
                        />

                        {selected.length > 0 && (
                            <div className="divide-border flex flex-col divide-y rounded-md border">
                                {selected.map((repo) => (
                                    <div
                                        key={repo.id}
                                        className="flex items-center justify-between px-3 py-2">
                                        <span className="text-text-primary text-sm">
                                            {repo.full_name || repo.name}
                                        </span>
                                        {canEdit && (
                                            <Button
                                                size="icon-sm"
                                                variant="cancel"
                                                aria-label={`Remove ${repo.name}`}
                                                onClick={() =>
                                                    removeFromSelection(
                                                        String(repo.id),
                                                    )
                                                }>
                                                <Trash2 className="size-4" />
                                            </Button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className="flex items-center gap-2">
                            <Button
                                size="md"
                                variant="primary"
                                loading={isSaving}
                                disabled={!canEdit || !isDirty}
                                onClick={handleSave}>
                                Save changes
                            </Button>
                            <Button
                                size="md"
                                variant="helper"
                                loading={isResyncing}
                                disabled={
                                    !canEdit || savedSources.length === 0
                                }
                                onClick={handleResync}>
                                Resync now
                            </Button>
                        </div>
                    </Section.Content>
                </Section.Root>
            </CardHeader>
        </Card>
    );
};
