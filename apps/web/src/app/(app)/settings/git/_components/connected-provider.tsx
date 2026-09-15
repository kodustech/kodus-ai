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

// Token-rotatable platforms (GitLab, Bitbucket, Azure Repos, Forgejo). GitHub
// is OAuth-app driven on connect, so there is no PAT to rotate from this card.
const UPDATE_TOKEN_PLATFORMS = new Set([
    "gitlab",
    "bitbucket",
    "azure_repos",
    "forgejo",
]);

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

    const canUpdateToken = UPDATE_TOKEN_PLATFORMS.has(platformKey);

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
