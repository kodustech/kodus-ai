import { axiosAuthorized } from "src/core/utils/axios";
import { pathToApiUrl } from "src/core/utils/helpers";

import { USERS_PATHS } from ".";
import { User } from "./types";

export const joinOrganization = async (
    userId: string,
    organizationId: string,
) => {
    const response = await axiosAuthorized.post<User>(
        USERS_PATHS.JOIN_ORGANIZATION,
        { userId, organizationId },
    );

    return response;
};

/** A fresh token for the invite link of a pending member (owner only). */
export const getInvitationToken = async (userId: string): Promise<string> => {
    const response = await axiosAuthorized.fetcher<{ data: { token: string } }>(
        pathToApiUrl(`/user/${encodeURIComponent(userId)}/invitation-token`),
    );
    // A 2xx without a token must not become a link to /invite/undefined.
    const token = response.data?.token;
    if (!token) throw new Error("The API returned no invitation token");
    return token;
};

export const updateUser = async (
    userId: string,
    data: Pick<Partial<User>, "role" | "status">,
) => {
    const response = await axiosAuthorized.patch<User>(
        pathToApiUrl(`/user/${userId}`),
        data,
    );

    return response;
};

export const saveMarketingSurvey = async (data: {
    referralSource?: string;
    primaryGoal?: string;
}) => {
    await axiosAuthorized.patch(USERS_PATHS.MARKETING_SURVEY, data);
};
