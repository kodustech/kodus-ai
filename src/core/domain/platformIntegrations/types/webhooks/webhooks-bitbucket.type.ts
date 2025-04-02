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
