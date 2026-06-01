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

export default async function GitRepositories() {
    const teamId = await getGlobalSelectedTeamId();

    let connectionsError = false;
    const [connectionsResult, selectedRepositories] = await Promise.all([
        getConnections(teamId).catch(() => {
            connectionsError = true;
            return [];
        }),
        getIntegrationConfig({ teamId }),
    ]);

    if (connectionsError) {
        return (
            <ErrorCard
                variant="card"
                message="Failed to load connections. Please try again."
            />
        );
    }

    const gitConnection = safeArray(connectionsResult).find(
        (c) => c.category === "CODE_MANAGEMENT",
    );
    if (!gitConnection) redirect("/settings/git");

    const provider =
        providers[
            gitConnection.platformName.toLowerCase() as keyof typeof providers
        ];

    return (
        <SelectRepositoriesModal
            platformName={provider.readableName}
            selectedRepositories={selectedRepositories}
        />
    );
}
