import { listCLIKeys } from "@services/cliKeys/fetch";
import type { CLIKey } from "@services/cliKeys/types";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";

import { CliKeysPage } from "./_page-component";

export default async function CliKeysSettingsPage() {
    const teamId = await getGlobalSelectedTeamId();

    let cliKeys: CLIKey[] = [];

    try {
        cliKeys = await listCLIKeys(teamId);
    } catch (error) {
        console.error("Failed to load CLI keys", error);
    }

    return <CliKeysPage teamId={teamId} initialKeys={cliKeys} />;
}
