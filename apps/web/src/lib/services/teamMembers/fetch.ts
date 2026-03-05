import { axiosAuthorized } from "src/core/utils/axios";

import { TEAM_MEMBERS_PATHS } from ".";

export const deleteTeamMember = async (uuid: string): Promise<any> => {
    try {
        const response = await axiosAuthorized.deleted(
            `${TEAM_MEMBERS_PATHS.DELETE}/${uuid}`,
            {
                params: { removeAll: false },
            },
        );

        return response;
    } catch (error: any) {
        return { error: error.response?.status || "Unknown error" };
    }
};
