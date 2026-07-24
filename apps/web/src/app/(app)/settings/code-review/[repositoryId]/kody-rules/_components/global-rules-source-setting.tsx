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
    const [deleteTarget, setDeleteTarget] = useState<Repository | null>(null);

    const savedIds = useMemo(
        () => new Set(savedSources.map((r) => String(r.id))),
        [savedSources],
    );

    // Seed the local selection from the persisted sources, preserving any
    // pending additions the user picked but hasn't saved yet — a delete
    // persists immediately and refetches `savedSources`, and we must not drop
    // in-progress additions when that happens.
    useEffect(() => {
        if (!repositories.length) return;
        const ids = new Set(savedSources.map((r) => String(r.id)));
        setSelected((prev) => {
            const saved = repositories.filter((r) => ids.has(String(r.id)));
            const pendingAdditions = prev.filter(
                (r) => !ids.has(String(r.id)),
            );
            return [...saved, ...pendingAdditions];
        });
    }, [repositories, savedSources]);

    // Removals are persisted immediately (with confirmation), so "Save" only
    // ever commits ADDITIONS — repos selected that aren't saved yet.
    const hasPendingAdditions = useMemo(
        () => selected.some((r) => !savedIds.has(String(r.id))),
        [selected, savedIds],
    );

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

    // Persist a removal on its own (not via Save): drops the repo from the
    // saved list, which the backend reconciles by soft-deleting that repo's
    // global rules. Pending additions in `selected` are intentionally NOT sent,
    // so a delete never triggers an import.
    const [handleDeleteConfirmed, { loading: isDeleting }] = useAsyncAction(
        async () => {
            if (!deleteTarget) return;
            const targetId = String(deleteTarget.id);
            try {
                await setGlobalSourceRepositories({
                    teamId,
                    repositories: savedSources
                        .filter((r) => String(r.id) !== targetId)
                        .map((r) => ({
                            id: String(r.id),
                            name: r.name,
                            fullName: r.fullName,
                        })),
                });
                await refreshSources();
                setSelected((prev) =>
                    prev.filter((r) => String(r.id) !== targetId),
                );
                toast({
                    variant: "success",
                    title: "Repository removed",
                    description:
                        "Its imported global rules have been deleted.",
                });
            } catch {
                toast({
                    variant: "danger",
                    title: "Could not remove repository",
                });
            } finally {
                setDeleteTarget(null);
            }
        },
    );

    // Trial: confirm the cap before importing. Paid: save directly.
    const onSaveClick = () => {
        if (isTrial) {
            setConfirmOpen(true);
            return;
        }
        handleSave();
    };

    // Trash: a saved repo needs delete confirmation (its rules get purged); a
    // not-yet-saved pending addition is just dropped from the local selection.
    const onTrashClick = (repo: Repository) => {
        if (savedIds.has(String(repo.id))) {
            setDeleteTarget(repo);
        } else {
            setSelected((prev) =>
                prev.filter((r) => String(r.id) !== String(repo.id)),
            );
        }
    };

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
                                {selected.map((repo) => {
                                    const isPending = !savedIds.has(
                                        String(repo.id),
                                    );
                                    return (
                                        <div
                                            key={repo.id}
                                            className="flex items-center justify-between px-3 py-2">
                                            <span className="flex items-center gap-2 text-sm">
                                                <span className="text-text-primary">
                                                    {repo.full_name || repo.name}
                                                </span>
                                                {isPending && (
                                                    <span className="text-warning border-warning/40 rounded border px-1.5 py-0.5 text-[11px]">
                                                        Not imported yet
                                                    </span>
                                                )}
                                            </span>
                                            {canEdit && (
                                                <Button
                                                    size="icon-sm"
                                                    variant="cancel"
                                                    aria-label={`Remove ${repo.name}`}
                                                    onClick={() =>
                                                        onTrashClick(repo)
                                                    }>
                                                    <Trash2 className="size-4" />
                                                </Button>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        <div className="flex items-center gap-2">
                            <Button
                                size="md"
                                variant="primary"
                                loading={isSaving}
                                disabled={!canEdit || !hasPendingAdditions}
                                onClick={onSaveClick}>
                                Import selected
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

            <ConfirmModal
                open={deleteTarget !== null}
                title="Remove global rule source?"
                description={
                    `The global Kody Rules imported from ` +
                    `"${deleteTarget?.full_name || deleteTarget?.name}" will be ` +
                    `deleted and will no longer apply during code review. This ` +
                    `cannot be undone.`
                }
                confirmText="Remove and delete rules"
                variant="tertiary"
                loading={isDeleting}
                onConfirm={handleDeleteConfirmed}
                onCancel={() => setDeleteTarget(null)}
            />
        </Card>
    );
};
