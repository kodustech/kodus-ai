import { UserRole } from "@enums";
import {
    getConnectionAccess,
    setConnectionAccess,
} from "@services/codeManagement/fetch";
import { SETUP_PATHS } from "@services/setup";
import type { MembersSetup, TeamMembersResponse } from "@services/setup/types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { axiosAuthorized } from "src/core/utils/axios";

export type ConnectionReader = { userId: string; name: string; email: string };

const connectionAccessKey = (teamId: string, connectionId: string) =>
    ["connection-access", teamId, connectionId] as const;

/** The workspace's members besides its owners, and which of them read the connection. */
export const useConnectionAccess = (teamId: string, connectionId: string) =>
    useQuery({
        queryKey: connectionAccessKey(teamId, connectionId),
        queryFn: async () => {
            const [membersResponse, userIds] = await Promise.all([
                axiosAuthorized.fetcher<{ data: TeamMembersResponse }>(
                    SETUP_PATHS.TEAM_MEMBERS,
                    { params: { teamId } },
                ),
                getConnectionAccess(teamId, connectionId),
            ]);
            const members: ConnectionReader[] = (
                (membersResponse?.data?.members ?? []) as MembersSetup[]
            )
                .filter(
                    (member) => member.userId && member.role !== UserRole.OWNER,
                )
                .map((member) => ({
                    userId: member.userId!,
                    name: member.name,
                    email: member.email,
                }));
            return { members, userIds };
        },
        // A failed read must not look like "nobody reads it".
        retry: false,
    });

/** Saves who reads the connection, then reads it again wherever it is shown. */
export const useSetConnectionAccess = (
    teamId: string,
    connectionId: string,
) => {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (userIds: string[]) =>
            setConnectionAccess(teamId, connectionId, userIds),
        onSuccess: () =>
            queryClient.invalidateQueries({
                queryKey: connectionAccessKey(teamId, connectionId),
            }),
    });
};
