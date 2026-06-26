import { axiosAuthorized } from "src/core/utils/axios";

import { INTEGRATION } from ".";

export const cloneIntegration = async (
    teamId: string,
    teamIdClone: string,
    integrationData: { platform: string; category: string },
) => {
    try {
        const response = await axiosAuthorized.post<any>(
            INTEGRATION.CLONE_INTEGRATION,
            {
                teamIdClone,
                teamId,
                integrationData,
            },
        );

        return response.data;
    } catch (error: any) {
        return { error: error.response?.status || "Erro desconhecido" };
    }
};

export const checkIssuesProviderSupported = async ({
    teamId,
}: {
    teamId: string;
}) => {
    try {
        const response = await axiosAuthorized.fetcher<boolean>(
            INTEGRATION.ISSUES_SUPPORTED,
            {
                params: { teamId },
            },
        );

        return response.data;
    } catch (error: any) {
        return { error: error.response?.status || "Erro desconhecido" };
    }
};

export const checkHasConnectionByPlatform = async ({
    platform,
    category,
}: {
    platform: string;
    category: string;
}) => {
    try {
        const response = await axiosAuthorized.fetcher<any>(
            INTEGRATION.CHECK_CONNECTION_PLATFORM,
            {
                params: {
                    platform,
                    category,
                },
            },
        );

        return response.data;
    } catch (error: any) {
        return { error: error.response?.status || "Erro desconhecido" };
    }
};
