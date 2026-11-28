"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { magicModal } from "@components/ui/magic-modal";
import { Switch } from "@components/ui/switch";
import { toast } from "@components/ui/toaster/use-toast";
import { updateConnection } from "@services/codeManagement/fetch";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { getConnections } from "@services/setup/fetch";
import {
    FolderGit2Icon,
    KeyRoundIcon,
    PencilIcon,
    RefreshCcwIcon,
    UsersIcon,
} from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { AuthMode, type AwaitedReturnType } from "src/core/types";

import { CODE_MANAGEMENT_PLATFORMS, connectionLabel } from "../_constants";
import { ConnectionAccessModal } from "./_modals/connection-access-modal";
import { RenameConnectionModal } from "./_modals/rename-connection-modal";
import { ResetIntegrationModal } from "./_modals/reset-integration-modal";
import { UpdateTokenIntegrationModal } from "./_modals/update-token-integration-modal";

// Platforms this card can rotate a token for. GitHub is OAuth-app driven on
// connect so there is no PAT to rotate; Azure Repos and Bitbucket are out too,
// because the modal's upsert carries only a token and a host while Azure
// validates an org name, Bitbucket Cloud authenticates with an email and
// Bitbucket Data Center with BASIC auth - it would blank those or fail.
const UPDATE_TOKEN_PLATFORMS = new Set(["gitlab", "forgejo"]);

export const GitConnectedProvider = ({
    connection,
    connections,
    showConnectionActions = false,
}: {
    connection: AwaitedReturnType<typeof getConnections>[number];
    /** The workspace's Git connections, to tell unnamed ones apart. */
    connections?: AwaitedReturnType<typeof getConnections>;
    /** A workspace with several connections manages each one here. */
    showConnectionActions?: boolean;
}) => {
    const router = useRouter();
    const { teamId } = useSelectedTeamId();

    const canDelete = usePermission(Action.Delete, ResourceType.GitSettings);
    const canUpdate = usePermission(Action.Update, ResourceType.GitSettings);

    const [reviewEnabled, setReviewEnabled] = useState(
        connection.reviewEnabled !== false,
    );
    const [savingReview, setSavingReview] = useState(false);

    const platformKey =
        connection.platformName.toLowerCase() as keyof typeof CODE_MANAGEMENT_PLATFORMS;
    const platform = CODE_MANAGEMENT_PLATFORMS[platformKey];
    const label = connectionLabel(connection, connections);

    // A GitLab connection made through OAuth stays OAuth: the modal saves a
    // token, so offering it there would swap the authentication mode.
    const connectedWithOAuth =
        (connection.config as { authMode?: string } | undefined)?.authMode ===
        AuthMode.OAUTH;

    const canUpdateToken =
        UPDATE_TOKEN_PLATFORMS.has(platformKey) && !connectedWithOAuth;

    const toggleReview = async (enabled: boolean) => {
        if (!connection.connectionId) return;
        setSavingReview(true);
        setReviewEnabled(enabled);
        try {
            await updateConnection({
                teamId,
                connectionId: connection.connectionId,
                reviewEnabled: enabled,
            });
            router.refresh();
        } catch {
            setReviewEnabled(!enabled);
            toast({
                variant: "warning",
                title: "Could not change reviews for this connection",
            });
        } finally {
            setSavingReview(false);
        }
    };

    return (
        <Card className="min-w-68">
            <CardHeader className="flex-row items-center justify-between gap-3 px-5 py-2.5">
                <div className="flex items-center gap-3">
                    <span className="*:size-6">
                        <platform.svg />
                    </span>

                    <span className="flex flex-col">
                        <span className="text-sm font-bold">{label}</span>
                        {connection.connectionName && (
                            <span className="text-text-secondary text-xs">
                                {platform.platformName}
                            </span>
                        )}
                    </span>
                </div>

                <div className="flex items-center gap-1">
                    {showConnectionActions && connection.connectionId && (
                        <>
                            <label className="text-text-secondary mr-2 flex items-center gap-2 text-xs">
                                Reviews
                                <Switch
                                    size="sm"
                                    checked={reviewEnabled}
                                    loading={savingReview}
                                    disabled={!canUpdate}
                                    onCheckedChange={toggleReview}
                                />
                            </label>

                            <Button
                                size="xs"
                                variant="tertiary"
                                leftIcon={<FolderGit2Icon />}
                                disabled={!canUpdate}
                                onClick={() =>
                                    router.push(
                                        `/settings/git/repositories?connectionId=${encodeURIComponent(connection.connectionId!)}`,
                                    )
                                }>
                                Repositories
                            </Button>

                            <Button
                                size="xs"
                                variant="tertiary"
                                leftIcon={<PencilIcon />}
                                disabled={!canUpdate}
                                onClick={() => {
                                    magicModal.show(() => (
                                        <RenameConnectionModal
                                            teamId={teamId}
                                            connectionId={
                                                connection.connectionId!
                                            }
                                            currentName={
                                                connection.connectionName
                                            }
                                        />
                                    ));
                                }}>
                                Rename
                            </Button>

                            <Button
                                size="xs"
                                variant="tertiary"
                                leftIcon={<UsersIcon />}
                                disabled={!canUpdate}
                                onClick={() => {
                                    magicModal.show(() => (
                                        <ConnectionAccessModal
                                            teamId={teamId}
                                            connectionId={
                                                connection.connectionId!
                                            }
                                            connectionLabel={label}
                                        />
                                    ));
                                }}>
                                Access
                            </Button>
                        </>
                    )}

                    {canUpdateToken && (
                        <Button
                            size="xs"
                            variant="tertiary"
                            leftIcon={<KeyRoundIcon />}
                            disabled={!canDelete}
                            onClick={() => {
                                magicModal.show(() => (
                                    <UpdateTokenIntegrationModal
                                        host={connection.config?.host}
                                        platformKey={platformKey}
                                        platformName={platform.platformName}
                                        teamId={teamId}
                                        connectionId={connection.connectionId}
                                    />
                                ));
                            }}>
                            Update token
                        </Button>
                    )}

                    <Button
                        size="xs"
                        variant="tertiary"
                        leftIcon={<RefreshCcwIcon />}
                        disabled={!canDelete}
                        onClick={() => {
                            magicModal.show(() => (
                                <ResetIntegrationModal
                                    platformName={label}
                                    teamId={teamId}
                                    connectionId={connection.connectionId}
                                    ownSubscription={connection.ownSubscription}
                                />
                            ));
                        }}>
                        Reset
                    </Button>
                </div>
            </CardHeader>
        </Card>
    );
};
