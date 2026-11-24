import { redirect } from "next/navigation";
import { getIntegrationConfig } from "@services/integrations/integrationConfig/fetch";
import { getConnections } from "@services/setup/fetch";
import { ErrorCard } from "src/core/components/ui/error-card";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { safeArray } from "src/core/utils/safe-array";

import { SelectRepositoriesModal } from "../../_components/_modals/select-repositories-modal";

const providers = {
    azure_repos: {
        readableName: "Azure Repos",
    },
    github: {
        readableName: "Github",
    },
    gitlab: {
        readableName: "Gitlab",
    },
    bitbucket: {
        readableName: "Bitbucket",
    },
    forgejo: {
        readableName: "Forgejo",
    },
} as const satisfies Record<string, { readableName: string }>;

export default async function GitRepositories({
    searchParams,
}: {
    searchParams: Promise<{ connectionId?: string }>;
}) {
    const teamId = await getGlobalSelectedTeamId();
    const { connectionId: requestedConnectionId } = await searchParams;

    let connectionsError = false;
    const connectionsResult = await getConnections(teamId).catch(() => {
        connectionsError = true;
        return [];
    });

    if (connectionsError) {
        return (
            <ErrorCard
                variant="card"
                message="Failed to load connections. Please try again."
            />
        );
    }

    const gitConnections = safeArray(connectionsResult).filter(
        (c) => c.category === "CODE_MANAGEMENT",
    );
    // The named connection, or the workspace's only one.
    const gitConnection = requestedConnectionId
        ? gitConnections.find((c) => c.connectionId === requestedConnectionId)
        : gitConnections.length === 1
          ? gitConnections[0]
          : undefined;
    if (!gitConnection) redirect("/settings/git");

    const selectedRepositories = await getIntegrationConfig({
        teamId,
        connectionId: gitConnection.connectionId,
    });

    const provider =
        providers[
            gitConnection.platformName.toLowerCase() as keyof typeof providers
        ];

    return (
        <SelectRepositoriesModal
            platformName={gitConnection.connectionName ?? provider.readableName}
            selectedRepositories={selectedRepositories}
            connectionId={gitConnection.connectionId}
        />
    );
}
