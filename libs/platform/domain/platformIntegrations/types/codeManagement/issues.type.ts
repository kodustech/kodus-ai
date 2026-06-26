import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

/**
 * Provider-agnostic issue, normalized across code hosts (GitHub, GitLab,
 * Bitbucket, Forgejo). `number` is the per-repo/project human identifier a PR
 * references ("fixes #123"); `id` is the host's global id as a string.
 */
export type CodeManagementIssue = {
    id: string;
    number: number;
    title: string;
    body: string | null;
    state: 'open' | 'closed';
    url: string;
    labels: string[];
    assignees: string[];
    author: { username: string; id?: string } | null;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    platform: PlatformType;
};

export type ListIssuesParams = {
    organizationAndTeamData: OrganizationAndTeamData;
    // `owner/name` identifies the repo across hosts (GitLab uses it as the
    // project path).
    repository: { owner: string; name: string };
    filters?: {
        state?: 'open' | 'closed' | 'all';
        labels?: string[];
        assignee?: string;
        since?: string;
        page?: number;
        perPage?: number;
    };
};

export type GetIssueParams = {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { owner: string; name: string };
    issueNumber: number;
};

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
