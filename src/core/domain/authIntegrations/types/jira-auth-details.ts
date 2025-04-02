export type JiraAuthDetail = {
    baseUrl: string;
    boardId: string;
    cloudId: string;
    platform: string;
    authToken: string;
    projectId: string;
    projectKey: string;
    refreshToken: string;
    expiresIn: number;
    lastRefreshedAt: number;
};
