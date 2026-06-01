import type { Team } from "@services/teams/types";
import { TEAM_STATUS } from "src/core/types";

export const resolveInitialSettingsTeamId = (
    teams: Team[],
    selectedTeamIdFromCookie?: string,
) => {
    const selectedTeam = teams.find(
        (team) =>
            team.uuid === selectedTeamIdFromCookie &&
            team.status === TEAM_STATUS.ACTIVE,
    );

    if (selectedTeam) {
        return selectedTeam.uuid;
    }

    return teams.find((team) => team.status === TEAM_STATUS.ACTIVE)?.uuid;
};
