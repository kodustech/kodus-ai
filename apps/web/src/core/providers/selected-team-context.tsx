"use client";

import { createContext, useContext, useState } from "react";

import { TEAM_STATUS } from "../types";
import { ClientSideCookieHelpers } from "../utils/cookie";
import { revalidateServerSideTag } from "../utils/revalidate-server-side";
import { useAllTeams } from "./all-teams-context";

const TeamContext = createContext<{
    teamId: string | undefined;
    setTeamId: (teamId: string) => void;
}>({
    teamId: undefined,
    setTeamId: () => {},
});

export const useSelectedTeamId = () => {
    const { teams } = useAllTeams();
    const context = useContext(TeamContext);

    let teamId = context.teamId;
    const team = teams.find((team) => team.uuid === teamId);

    if (!context.teamId || !team || team.status !== TEAM_STATUS.ACTIVE) {
        teamId = teams?.at(0)?.uuid!;
    }

    return { ...context, teamId: teamId as string };
};

const cookieHelpers = ClientSideCookieHelpers("global-selected-team-id");

export const SelectedTeamProvider = ({ children }: React.PropsWithChildren) => {
    const [teamId, _setTeamId] = useState<
        React.ContextType<typeof TeamContext>["teamId"]
    >(cookieHelpers.get());

    return (
        <TeamContext.Provider
            value={{
                teamId,
                setTeamId: (teamId) => {
                    _setTeamId(teamId);
                    cookieHelpers.set(teamId);
                    revalidateServerSideTag("team-dependent");
                },
            }}>
            {children}
        </TeamContext.Provider>
    );
};
