import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export type GitHubIssue = {
    id: number;
    nodeId: string;
    number: number;
    title: string;
    body: string | null;
    state: 'open' | 'closed';
    locked: boolean;
    htmlUrl: string;
    comments: number;
    labels: string[];
    assignees: string[];
    user: {
        login: string;
        id: number;
        avatarUrl?: string;
        htmlUrl?: string;
    } | null;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
};

export type ListGitHubIssuesParams = {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: {
        owner: string;
        name: string;
    };
    filters?: {
        state?: 'open' | 'closed' | 'all';
        labels?: string[];
        assignee?: string;
        creator?: string;
        since?: string;
        sort?: 'created' | 'updated' | 'comments';
        direction?: 'asc' | 'desc';
        page?: number;
        perPage?: number;
    };
};

export type GetGitHubIssueParams = {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: {
        owner: string;
        name: string;
    };
    issueNumber: number;
};
