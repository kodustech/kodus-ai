export interface IMappedPlatform {
    mapPullRequest: (params: { payload: any }) => IMappedPullRequest | null;
    mapUsers: (params: { payload: any }) => IMappedUsers | null;
    mapRepository: (params: { payload: any }) => IMappedRepository | null;
    mapComment: (params: { payload: any }) => IMappedComment | null;
    mapAction: (params: {
        payload: any;
        event?: string;
    }) => MappedAction | string | null;
}

export interface IMappedUsers {
    user: any;
    assignees: any;
    reviewers: any;
}

export interface IMappedPullRequest {
    repository: any;
    title: string;
    body: string;
    number: number;
    user: any;
    head: {
        ref: string;
        repo: {
            fullName: string;
        };
        sha?: string;
    };
    base: {
        ref: string;
        repo: {
            fullName: string;
            defaultBranch: string;
        };
        /** Absent when the payload has none (GitLab). */
        sha?: string;
    };
    status?: string;
    isDraft: boolean;
    url: string;
    tags: string[];
}

export interface IMappedRepository {
    id: string;
    name: string;
    language: string;
    fullName: string;
    url: string;
}

export interface IMappedComment {
    id: string;
    body: string;
}

export enum MappedAction {
    OPENED = 'opened',
    UPDATED = 'updated',
}
