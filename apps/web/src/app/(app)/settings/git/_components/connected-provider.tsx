"use client";

import { Button } from "@components/ui/button";
import { Card, CardHeader } from "@components/ui/card";
import { magicModal } from "@components/ui/magic-modal";
import { usePermission } from "@services/permissions/hooks";
import { Action, ResourceType } from "@services/permissions/types";
import type { getConnections } from "@services/setup/fetch";
import { KeyRoundIcon, RefreshCcwIcon } from "lucide-react";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import type { AwaitedReturnType } from "src/core/types";

import { CODE_MANAGEMENT_PLATFORMS } from "../_constants";
import { UpdateTokenIntegrationModal } from "./_modals/update-token-integration-modal";
import { ResetIntegrationModal } from "./_modals/reset-integration-modal";

// Platforms this card can rotate a token for. GitHub is OAuth-app driven on
// connect so there is no PAT to rotate; Azure Repos and Bitbucket are out too,
// because the modal's upsert carries only a token and a host while Azure
// validates an org name, Bitbucket Cloud authenticates with an email and
// Bitbucket Data Center with BASIC auth - it would blank those or fail.
const UPDATE_TOKEN_PLATFORMS = new Set(["gitlab", "forgejo"]);

export const GitConnectedProvider = ({
    connection,
}: {
    connection: AwaitedReturnType<typeof getConnections>[number];
}) => {
    const { teamId } = useSelectedTeamId();

    const canDelete = usePermission(Action.Delete, ResourceType.GitSettings);

    const platformKey =
        connection.platformName.toLowerCase() as keyof typeof CODE_MANAGEMENT_PLATFORMS;
    const platform = CODE_MANAGEMENT_PLATFORMS[platformKey];

    // A GitLab connection made through OAuth stays OAuth: the modal saves a
    // token, so offering it there would swap the authentication mode.
    const connectedWithOAuth =
        (connection.config as { authMode?: string } | undefined)?.authMode ===
        AuthMode.OAUTH;

    const canUpdateToken =
        UPDATE_TOKEN_PLATFORMS.has(platformKey) && !connectedWithOAuth;

    return (
        <Card className="min-w-68">
            <CardHeader className="flex-row items-center justify-between gap-3 px-5 py-2.5">
                <div className="flex items-center gap-3">
                    <span className="*:size-6">
                        <platform.svg />
                    </span>

                    <span className="text-sm font-bold">
                        {platform.platformName}
                    </span>
                </div>

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
                                platformName={platform.platformName}
                                teamId={teamId}
                            />
                        ));
                    }}>
                    Reset
                </Button>
            </CardHeader>
        </Card>
    );
};
