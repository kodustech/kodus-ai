import { redirect } from "next/navigation";
import { useSuspenseGetConnections } from "@services/setup/hooks";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { safeArray } from "src/core/utils/safe-array";

export const useGoToStep = (overrideRedirectPath?: string) => {
    const { teamId } = useSelectedTeamId();
    const connections = useSuspenseGetConnections(teamId);

    const codeManagementConnections = safeArray(connections).filter(
        (c) => c.category === "CODE_MANAGEMENT" && c.hasConnection,
    );

    if (codeManagementConnections.length) {
        redirect(overrideRedirectPath || "/setup/choosing-repositories");
    }
};
