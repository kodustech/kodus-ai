export type Repositories = {
    id: string;
    name: string;
    http_url: string;
    avatar_url: string;
    organizationName: string;
    visibility: 'public' | 'private';
    selected: boolean;
    default_branch?: string;
    project?: {
        id: string;
        name: string;
    };
    workspaceId?: string;
};
