"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { Section } from "@components/ui/section";
import { toast } from "@components/ui/toaster/use-toast";
import { ConfirmModal } from "@components/ui/confirm-modal";
import { useAsyncAction } from "@hooks/use-async-action";
import { useReactQueryInvalidateQueries } from "@hooks/use-invalidate-queries";
import { SelectRepositories } from "@components/system/select-repositories";
import { GateCtaLink } from "@components/system/gate-cta-link";
import { useGetRepositories } from "@services/codeManagement/hooks";
import type { Repository } from "@services/codeManagement/types";
import { KODY_RULES_PATHS } from "@services/kodyRules";
import {
    resyncGlobalRules,
    setGlobalSourceRepositories,
} from "@services/kodyRules/fetch";
import {
    useSuspenseGlobalRulesImportStatus,
    useSuspenseGlobalRulesSourceRepositories,
} from "@services/kodyRules/hooks";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { LockIcon, Trash2 } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

/**
 * Configuration control (global scope only) that lets the user pick one or more
 * connected repositories as sources of GLOBAL Kody Rules. Access depends on the
 * org's plan:
 *   - free  → the whole control is grayed out with an upgrade CTA.
 *   - trial → capped at `limit` imported rules; a counter is shown and a
 *             confirmation modal spells out that only the first N rules found
 *             (across all selected repos) will be imported.
 *   - paid  → unrestricted.
 */
export const GlobalRulesSourceSetting = () => {
    const { teamId } = useSelectedTeamId();
    const { invalidateQueries, generateQueryKey } =
        useReactQueryInvalidateQueries();
    const canEdit = usePermission(Action.Create, ResourceType.KodyRules);

    const savedSources = useSuspenseGlobalRulesSourceRepositories({ teamId });
    const importStatus = useSuspenseGlobalRulesImportStatus({ teamId });
    const { data: repositories = [] } = useGetRepositories(teamId);

    const isFree = importStatus.tier === "free";
    const isTrial = importStatus.tier === "trial";

    const [pickerOpen, setPickerOpen] = useState(false);
    const [selected, setSelected] = useState<Repository[]>([]);
    const [confirmOpen, setConfirmOpen] = useState(false);

    // Seed the local selection from the persisted sources once the repository
    // list is available (the picker compares by id, so we resolve full
    // Repository objects from the fetched list).
    useEffect(() => {
        if (!repositories.length) return;
        const savedIds = new Set(savedSources.map((r) => String(r.id)));
        setSelected(repositories.filter((r) => savedIds.has(String(r.id))));
    }, [repositories, savedSources]);

    const isDirty = useMemo(() => {
        const a = new Set(selected.map((r) => String(r.id)));
        const b = new Set(savedSources.map((r) => String(r.id)));
        if (a.size !== b.size) return true;
        for (const id of a) if (!b.has(id)) return true;
        return false;
    }, [selected, savedSources]);

    const refreshSources = () => {
        invalidateQueries({
            queryKey: generateQueryKey(
                KODY_RULES_PATHS.GLOBAL_SOURCE_REPOSITORIES,
                { params: { teamId } },
            ),
        });
        invalidateQueries({
            queryKey: generateQueryKey(
                KODY_RULES_PATHS.GLOBAL_RULES_IMPORT_STATUS,
                { params: { teamId } },
            ),
        });
    };

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
                description: isTrial
                    ? `Importing up to ${importStatus.limit} rules (Trial plan) in the background.`
                    : "Rules from the selected repositories are being imported in the background.",
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

    // Trial: confirm the cap before importing. Paid: save directly.
    const onSaveClick = () => {
        if (isTrial) {
            setConfirmOpen(true);
            return;
        }
        handleSave();
    };

    const removeFromSelection = (id: string) =>
        setSelected((prev) => prev.filter((r) => String(r.id) !== String(id)));

    const header = (
        <Section.Header>
            <Section.Title>Global rule sources</Section.Title>
            <Section.Description>
                Select connected repositories to import their rule files as
                global Kody Rules. Global rules apply to every repository during
                code review.
            </Section.Description>
        </Section.Header>
    );

    // FREE PLAN — feature locked. Show the control grayed out (read-only) with
    // an upgrade CTA. Nothing here is editable.
    if (isFree) {
        return (
            <Card>
                <CardHeader>
                    <Section.Root>
                        {header}
                        <Section.Content className="flex flex-col gap-4">
                            <div
                                aria-disabled
                                className="pointer-events-none flex select-none flex-col gap-4 opacity-50">
                                <SelectRepositories
                                    id="global-rules-source-picker"
                                    open={false}
                                    onOpenChange={() => {}}
                                    selectedRepositories={[]}
                                    onChangeSelectedRepositories={() => {}}
                                    teamId={teamId}
                                    filterRepository={(r) => r.selected === true}
                                />
                                <Button size="md" variant="primary" disabled>
                                    Save changes
                                </Button>
                            </div>

                            <div className="border-card-lv3 bg-card-lv1 flex flex-col gap-3 rounded-md border p-4">
                                <div className="text-text-primary flex items-center gap-2 text-sm font-medium">
                                    <LockIcon className="size-4" />
                                    Importing global rules is a paid feature
                                </div>
                                <p className="text-text-secondary text-sm">
                                    Upgrade your plan to import architecture and
                                    coding standards from a repository and apply
                                    them across all your repos during code
                                    review.
                                </p>
                                <GateCtaLink
                                    feature="kody_rules"
                                    plan="free"
                                    metadata={{ surface: "global_rules_source" }}
                                    size="sm"
                                    className="self-start"
                                />
                            </div>
                        </Section.Content>
                    </Section.Root>
                </CardHeader>
            </Card>
        );
    }

    // TRIAL / PAID
    const limitReached =
        isTrial &&
        importStatus.remaining !== null &&
        importStatus.remaining <= 0;

    return (
        <Card>
            <CardHeader>
                <Section.Root>
                    {header}

                    <Section.Content className="flex flex-col gap-4">
                        {isTrial && (
                            <div className="border-card-lv3 bg-card-lv1 flex items-center justify-between rounded-md border px-3 py-2">
                                <span className="text-text-secondary text-sm">
                                    Global rules imported (Trial plan)
                                </span>
                                <span className="text-sm font-semibold">
                                    <span
                                        className={
                                            limitReached
                                                ? "text-danger"
                                                : "text-primary-light"
                                        }>
                                        {importStatus.used}
                                    </span>
                                    <span className="text-text-secondary">
                                        {" / "}
                                        {importStatus.limit}
                                    </span>
                                </span>
                            </div>
                        )}

                        {limitReached && (
                            <p className="text-text-secondary text-sm">
                                You've reached the Trial limit of{" "}
                                <span className="text-text-primary font-semibold">
                                    {importStatus.limit} global rules
                                </span>
                                . Remove a source or upgrade to import more.
                            </p>
                        )}

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
                                onClick={onSaveClick}>
                                Save changes
                            </Button>
                            <Button
                                size="md"
                                variant="helper"
                                loading={isResyncing}
                                disabled={!canEdit || savedSources.length === 0}
                                onClick={handleResync}>
                                Resync now
                            </Button>
                        </div>
                    </Section.Content>
                </Section.Root>
            </CardHeader>

            <ConfirmModal
                open={confirmOpen}
                title="Import global rules?"
                description={
                    `On the Trial plan, only the first ${importStatus.limit} rules found ` +
                    `(across all selected repositories) are imported. ` +
                    `You currently have ${importStatus.used} of ${importStatus.limit} imported` +
                    `${
                        importStatus.remaining !== null
                            ? `, so up to ${importStatus.remaining} more will be added`
                            : ""
                    }.`
                }
                confirmText="Import"
                variant="primary"
                loading={isSaving}
                onConfirm={() => {
                    setConfirmOpen(false);
                    handleSave();
                }}
                onCancel={() => setConfirmOpen(false)}
            />
        </Card>
    );
};
