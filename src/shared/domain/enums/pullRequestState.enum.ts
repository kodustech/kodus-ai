export enum PullRequestState {
    OPENED = 'open',
    CLOSED = 'closed',
    ALL = 'all',
    MERGED = 'merged',
}

export enum GithubPullRequestState {
    OPENED = 'open',
    CLOSED = 'closed',
    ALL = 'all',
}

export enum GitlabPullRequestState {
    OPENED = 'opened',
    CLOSED = 'closed',
    LOCKED = 'locked',
    MERGED = 'merged',
}

export enum AzureGitPullRequestState {
    ACTIVE = 'active',
    COMPLETED = 'completed',
    ABANDONED = 'abandoned',
}
