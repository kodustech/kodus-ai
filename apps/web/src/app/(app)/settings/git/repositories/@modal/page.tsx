import { redirect } from "next/navigation";
import { getIntegrationConfig } from "@services/integrations/integrationConfig/fetch";
import { getConnections } from "@services/setup/fetch";
import { ErrorCard } from "src/core/components/ui/error-card";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";
import { safeArray } from "src/core/utils/safe-array";

import { SelectRepositoriesModal } from "../../_components/_modals/select-repositories-modal";
import { connectionLabel } from "../../_constants";

export default async function GitRepositories({
    searchParams,
}: {
    searchParams: Promise<{ connectionId?: string }>;
}) {
    const teamId = await getGlobalSelectedTeamId();
    const { connectionId: requestedConnectionId } = await searchParams;

    let connectionsError = false;
    // With the connection named, its saved repositories need nothing from
    // the connections list: both are read together, then checked.
    const [connectionsResult, namedRepositories] = await Promise.all([
        getConnections(teamId).catch(() => {
            connectionsError = true;
            return [];
        }),
        requestedConnectionId
            ? getIntegrationConfig({
                  teamId,
                  connectionId: requestedConnectionId,
              })
            : undefined,
    ]);

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

    const selectedRepositories =
        namedRepositories ??
        (await getIntegrationConfig({
            teamId,
            connectionId: gitConnection.connectionId,
        }));

    return (
        <SelectRepositoriesModal
            platformName={connectionLabel(gitConnection, gitConnections)}
            selectedRepositories={selectedRepositories}
            connectionId={gitConnection.connectionId}
        />
    );
}
