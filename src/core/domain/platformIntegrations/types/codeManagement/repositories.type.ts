export type Repositories = {
    id: string;
    name: string;
    full_name?: string;
    http_url: string;
    avatar_url: string;
    organizationName: string;
    visibility: 'public' | 'private';
    selected: boolean;
    default_branch?: string;
    language?: string;
    lastActivityAt?: string;
    project?: {
        id: string;
        name: string;
    };
    workspaceId?: string;
    directories?: Array<any>;
    recentPullRequestsCount?: number;
    recentPullRequestsWindowDays?: number;
};
