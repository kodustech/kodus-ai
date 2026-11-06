"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import { magicModal } from "@components/ui/magic-modal";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import {
    fetchRepositorySelection,
    setRepositorySelection,
    type RepositorySelection,
    type RepositorySyncStatus,
} from "@services/codeManagement/repositorySelection";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { EnableReviewAllModal } from "./_modals/enable-review-all-modal";

const POLL_MS = 5_000;

const formatTime = (iso?: string) =>
    iso ? new Date(iso).toLocaleString() : undefined;

const SyncStatusLine = ({ sync }: { sync: RepositorySyncStatus | null }) => {
    if (!sync) {
        return (
            <p className="text-text-secondary text-sm">
                Waiting for the first sync.
            </p>
        );
    }

    if (sync.status === "running") {
        const total = sync.total ?? 0;
        return (
            <div className="space-y-1">
                <p className="text-text-primary text-sm">
                    {total > 0
                        ? `Setting up repositories: ${sync.done ?? 0} of ${total}.`
                        : "Looking for new repositories…"}
                </p>
                {total > 0 && (
                    <div className="bg-card-lv3 h-1.5 w-full overflow-hidden rounded-full">
                        <div
                            className="bg-primary-light h-full"
                            style={{
                                width: `${Math.round(((sync.done ?? 0) / total) * 100)}%`,
                            }}
                        />
                    </div>
                )}
            </div>
        );
    }

    if (sync.status === "failed" || sync.status === "rate_limited") {
        return (
            <p className="text-warning text-sm">
                {sync.error ?? "The last sync did not finish."} Last successful
                sync: {formatTime(sync.lastSuccessAt) ?? "never"}.
            </p>
        );
    }

    const background = [
        sync.pendingAstBuilds > 0 &&
            `${sync.pendingAstBuilds} code graphs still to build`,
        sync.pendingBackfills > 0 &&
            `${sync.pendingBackfills} pull request histories still to import`,
    ].filter(Boolean);

    return (
        <p className="text-text-secondary text-sm">
            Last checked {formatTime(sync.finishedAt)}.{" "}
            {sync.added
                ? `${sync.added} new ${sync.added === 1 ? "repository" : "repositories"} added.`
                : "No new repositories."}
            {background.length > 0 &&
                ` In the background: ${background.join(", ")}.`}
        </p>
    );
};

export const ReviewAllRepositoriesCard = ({
    platformName,
    initialSelection,
}: {
    platformName: string;
    initialSelection: RepositorySelection;
}) => {
    const router = useRouter();
    const { teamId } = useSelectedTeamId();
    const canEdit = usePermission(Action.Create, ResourceType.GitSettings);
    const [selection, setSelection] = useState(initialSelection);
    const [seenInitial, setSeenInitial] = useState(initialSelection);
    const [saving, setSaving] = useState(false);

    // A server refresh hands down a new selection; adopt it.
    if (seenInitial !== initialSelection) {
        setSeenInitial(initialSelection);
        setSelection(initialSelection);
    }

    const running =
        selection.mode === "all" && selection.sync?.status === "running";
    const waitingForFirstSync = selection.mode === "all" && !selection.sync;

    useEffect(() => {
        if (!running && !waitingForFirstSync) return;

        const timer = setInterval(async () => {
            try {
                const next = await fetchRepositorySelection(teamId);
                setSelection(next);
                if (next.sync && next.sync.status !== "running") {
                    router.refresh();
                }
            } catch {
                // Keep the last known state; the next tick retries.
            }
        }, POLL_MS);

        return () => clearInterval(timer);
    }, [running, waitingForFirstSync, teamId, router]);

    const save = async (
        mode: "manual" | "all",
        includeForksAndMirrors: boolean,
    ) => {
        setSaving(true);
        try {
            await setRepositorySelection({
                teamId,
                mode,
                includeForksAndMirrors,
            });
            setSelection((current) => ({
                ...current,
                mode,
                includeForksAndMirrors,
            }));
            toast({
                variant: "success",
                title:
                    mode === "all"
                        ? "Every repository will be reviewed"
                        : "Back to choosing repositories",
                description:
                    mode === "all"
                        ? "Repositories are being set up now. New ones are added within about 10 minutes."
                        : "The repositories reviewed today stay as they are; new ones are no longer added.",
            });
            router.refresh();
        } catch {
            toast({
                variant: "danger",
                title: "Could not change the repository selection",
                description: "Please try again.",
            });
        } finally {
            setSaving(false);
        }
    };

    const onToggle = (checked: boolean) => {
        if (!checked) {
            save("manual", selection.includeForksAndMirrors).catch(
                () => undefined,
            );
            return;
        }

        magicModal.show(() => (
            <EnableReviewAllModal
                teamId={teamId}
                platformName={platformName}
                initialIncludeForksAndMirrors={selection.includeForksAndMirrors}
                onConfirm={(includeForksAndMirrors) =>
                    save("all", includeForksAndMirrors)
                }
            />
        ));
    };

    return (
        <Card className="mb-4">
            <CardHeader className="flex flex-row items-start justify-between gap-6">
                <div className="space-y-1">
                    <CardTitle className="text-base">
                        Review every repository
                    </CardTitle>
                    <CardDescription>
                        Review every repository this {platformName} integration
                        can see, including ones created later. Archived
                        repositories are skipped
                        {selection.includeForksAndMirrors
                            ? "."
                            : ", and so are forks and mirrors."}
                    </CardDescription>
                    {selection.mode === "all" && (
                        <div className="pt-2">
                            <SyncStatusLine sync={selection.sync} />
                        </div>
                    )}
                </div>

                <Switch
                    role="switch"
                    aria-label="Review every repository"
                    checked={selection.mode === "all"}
                    disabled={!canEdit || saving}
                    loading={saving}
                    onCheckedChange={onToggle}
                />
            </CardHeader>
        </Card>
    );
};
