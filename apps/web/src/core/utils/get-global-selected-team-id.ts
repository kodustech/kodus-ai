import { cookies } from "next/headers";
import { getTeams } from "@services/teams/fetch";
import { TEAM_STATUS } from "src/core/types";

import { CookieName } from "./cookie";

export const getGlobalSelectedTeamId = async () => {
    const teams = await getTeams();
    const cookieStore = await cookies();
    const selectedTeamIdFromCookie = cookieStore.get(
        "global-selected-team-id" satisfies CookieName,
    )?.value;
    const selectedTeamId =
        teams?.find((t) => t.uuid === selectedTeamIdFromCookie)?.uuid ??
        teams?.find((t) => t.status === TEAM_STATUS.ACTIVE)?.uuid!;

    return selectedTeamId;
};
