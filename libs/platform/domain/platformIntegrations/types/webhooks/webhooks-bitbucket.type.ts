export interface IWebhookBitbucketWorkspace {
    type: 'workspace';
    slug: string;
    name: string;
    uuid: string;
    links: {
        [key: string]: {
            href: string;
        };
    };
}

interface IWebhookBitbucketRepository {
    type: string;
    name: string;
    full_name: string;
    workspace: IWebhookBitbucketWorkspace;
    uuid: string;
    links: {
        [key in 'self' | 'html' | 'avatar']: {
            href: string;
        };
    };
    project: IWebhookBitbucketProject;
    website: string;
    scm: 'git' | 'hg';
    is_private: boolean;
}

export interface IWebhookBitbucketProject {
    type: string;
    name: string;
    uuid: string;
    links: {
        [key in 'html' | 'avatar']: {
            href: string;
        };
    };
    key: string;
}

interface IWebhookBitbucketComment {
    id: number;
    parent: { id: number };
    content: {
        raw: string;
        html: string;
        markup: 'markdown' | 'creole' | 'plain';
    };
    inline: {
        to: number | null;
        from: number | null;
        path: string;
    } | null;
    created_on: string;
    updated_on: string;
    links: {
        [key in 'self' | 'html']: {
            href: string;
        };
    };
}

enum WebhookBitbucketPullRequestState {
    OPEN = 'OPEN',
    MERGED = 'MERGED',
    DECLINED = 'DECLINED',
}

interface IWebhookBitbucketPullRequest {
    id: number;
    title: string;
    description: string;
    state: WebhookBitbucketPullRequestState;
    author: IWebhookBitbucketAccount;
    source: {
        branch: { name: string };
        commit: { hash: string };
        repository: IWebhookBitbucketRepository;
    };
    destination: {
        branch: { name: string };
        commit: { hash: string };
        repository: IWebhookBitbucketRepository;
    };
    merge_commit: { hash: string };
    participants: IWebhookBitbucketAccount[];
    reviewers: IWebhookBitbucketAccount[];
    close_source_branch: boolean;
    closed_by: IWebhookBitbucketAccount;
    reason: string;
    created_on: string;
    updated_on: string;
    links: {
        [key in 'self' | 'html']: {
            href: string;
        };
    };
    draft: boolean;
}

interface IWebhookBitbucketAccount {
    display_name: string;
    uuid: string;
    type: 'user' | 'team' | 'app';
}

export interface IWebhookBitbucketPullRequestEvent {
    actor: IWebhookBitbucketAccount;
    pullrequest: IWebhookBitbucketPullRequest;
    repository: IWebhookBitbucketRepository;
    comment?: IWebhookBitbucketComment;
    isDataCenterEvent: false; // Custom property to indicate if this is a Data Center event
}

interface IWebhookBitbucketDataCenterProject {
    key: string;
    id: number;
    name: string;
    public: boolean;
    type: string;
}

interface IWebhookBitbucketDataCenterRepository {
    slug: string;
    id: number;
    name: string;
    scmId: string;
    state: string;
    statusMessage: string;
    forkable: boolean;
    project: IWebhookBitbucketDataCenterProject;
}

interface IWebhookBitbucketDataCenterActor {
    name: string;
    emailAddress: string;
    id: number;
    displayName: string;
    active: boolean;
    slug: string;
    type: string;
}

interface IWebhookBitbucketDataCenterPullRequest {
    id: number;
    version: number;
    title: string;
    description: string;
    state: WebhookBitbucketPullRequestState;
    open: boolean;
    closed: boolean;
    draft: boolean;
    createdDate: string;
    updatedDate: string;
    fromRef: {
        id: string;
        displayId: string;
        latestCommit: string;
        repository: IWebhookBitbucketDataCenterRepository;
    };
    toRef: {
        id: string;
        displayId: string;
        latestCommit: string;
        repository: IWebhookBitbucketDataCenterRepository;
    };
    locked: boolean;
    author: {
        user: IWebhookBitbucketDataCenterActor;
        role: string;
        approved: boolean;
        status: string;
    };
    reviewers: Array<{
        user: IWebhookBitbucketDataCenterActor;
        role: string;
        approved: boolean;
        status: string;
    }>;
    participants: Array<{
        user: IWebhookBitbucketDataCenterActor;
        role: string;
        approved: boolean;
        status: string;
    }>;
}

interface IWebhookBitbucketDataCenterComment {
    properties: {
        repositoryId: number;
    };
    id: number;
    version: number;
    text: string;
    author: IWebhookBitbucketDataCenterActor;
    createdDate: string;
    updatedDate: string;
    comments: IWebhookBitbucketDataCenterComment[];
    tasks: any[];
}

export interface IWebhookBitbucketDataCenterPullRequestEvent {
    eventKey: string;
    date: string;
    actor: IWebhookBitbucketDataCenterActor;
    pullrequest: IWebhookBitbucketDataCenterPullRequest;
    comment?: IWebhookBitbucketDataCenterComment;
    commentParentId?: number;
    isDataCenterEvent: true; // Custom property to indicate Data Center event
}

/**
Because Bitbucket UUIDs are wrapped in curly braces, we need to strip them out.

This helper function will traverse the event object recursively and remove curly braces from any UUIDs it finds.
*/
export function stripCurlyBracesFromUUIDs(
    event: IWebhookBitbucketPullRequestEvent,
): IWebhookBitbucketPullRequestEvent {
    function processValue(value: any): any {
        if (typeof value === 'object' && value !== null) {
            if (Array.isArray(value)) {
                return value.map(processValue);
            }

            const newObj: any = {};
            for (const key in value) {
                if (key === 'uuid' && typeof value[key] === 'string') {
                    const uuidValue = value[key];
                    newObj[key] =
                        uuidValue.startsWith('{') && uuidValue.endsWith('}')
                            ? uuidValue.slice(1, -1)
                            : uuidValue;
                } else {
                    newObj[key] = processValue(value[key]);
                }
            }
            return newObj;
        }
        return value;
    }

    return processValue(event) as IWebhookBitbucketPullRequestEvent;
}
