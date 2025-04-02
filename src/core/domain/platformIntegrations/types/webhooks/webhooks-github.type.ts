export interface IWebhookGithubUser {
    name?: string;
    email?: string;
    login: string;
    id: number;
    node_id: string;
    avatar_url: string;
    gravatar_id: string | null;
    url: string;
    html_url: string;
    followers_url: string;
    following_url: string;
    gists_url: string;
    starred_url: string;
    subscriptions_url: string;
    organizations_url: string;
    repos_url: string;
    events_url: string;
    received_events_url: string;
    type: string;
    site_admin: boolean;
    starred_at?: string;
    user_view_type?: string;
}

interface IWebhookGithubLabel {
    id: number;
    node_id: string;
    url: string;
    name: string;
    description: string | null;
    color: string;
    default: boolean;
}

interface IWebhookGithubMilestone {
    url: string;
    html_url: string;
    labels_url: string;
    id: number;
    node_id: string;
    number: number;
    state: 'open' | 'closed';
    title: string;
    description: string | null;
    creator: IWebhookGithubUser;
    open_issues: number;
    closed_issues: number;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    due_on: string | null;
}

interface IWebhookGithubTeam {
    id: number;
    node_id: string;
    url: string;
    members_url: string;
    name: string;
    description: string | null;
    permission: string;
    privacy?: string;
    notification_setting?: string;
    html_url: string;
    repositories_url: string;
    slug: string;
    ldap_dn?: string;
}

export interface IWebhookGithubLicense {
    key: string;
    name: string;
    url: string | null;
    spdx_id: string | null;
    node_id: string;
    html_url?: string;
}

export interface IWebhookGithubPermissions {
    admin: boolean;
    pull: boolean;
    triage?: boolean;
    push: boolean;
    maintain?: boolean;
}

interface IWebhookGithubRepo {
    id: number;
    node_id: string;
    name: string;
    full_name: string;
    license: IWebhookGithubLicense;
    forks: number;
    permissions: IWebhookGithubPermissions;
    owner: IWebhookGithubUser;
    private: boolean;
    html_url: string;
    description: string | null;
    fork: boolean;
    url: string;
    archive_url: string;
    assignees_url: string;
    blobs_url: string;
    branches_url: string;
    collaborators_url: string;
    comments_url: string;
    commits_url: string;
    compare_url: string;
    contents_url: string;
    contributors_url: string;
    deployments_url: string;
    downloads_url: string;
    events_url: string;
    forks_url: string;
    git_commits_url: string;
    git_refs_url: string;
    git_tags_url: string;
    git_url: string;
    issue_comment_url: string;
    issue_events_url: string;
    issues_url: string;
    keys_url: string;
    labels_url: string;
    languages_url: string;
    merges_url: string;
    milestones_url: string;
    notifications_url: string;
    pulls_url: string;
    releases_url: string;
    ssh_url: string;
    stargazers_url: string;
    statuses_url: string;
    subscribers_url: string;
    subscription_url: string;
    tags_url: string;
    teams_url: string;
    trees_url: string;
    clone_url: string;
    mirror_url: string | null;
    hooks_url: string;
    svn_url: string;
    homepage: string | null;
    language: string | null;
    forks_count: number;
    stargazers_count: number;
    watchers_count: number;
    size: number;
    default_branch: string;
    open_issues_count: number;
    is_template?: boolean;
    topics?: string[];
    has_issues: boolean;
    has_projects: boolean;
    has_wiki: boolean;
    has_pages: boolean;
    has_downloads: boolean;
    has_discussions?: boolean;
    archived: boolean;
    disabled: boolean;
    visibility?: string;
    pushed_at: string | null;
    created_at: string | null;
    updated_at: string | null;
    allow_rebase_merge?: boolean;
    temp_clone_token?: string;
    allow_squash_merge?: boolean;
    allow_auto_merge?: boolean;
    delete_branch_on_merge?: boolean;
    allow_update_branch?: boolean;
    use_squash_pr_title_as_default?: boolean;
    squash_merge_commit_title?: 'PR_TITLE' | 'COMMIT_OR_PR_TITLE';
    squash_merge_commit_message?: 'PR_BODY' | 'COMMIT_MESSAGES' | 'BLANK';
    merge_commit_title?: 'PR_TITLE' | 'MERGE_MESSAGE';
    merge_commit_message?: 'PR_BODY' | 'PR_TITLE' | 'BLANK';
    allow_merge_commit?: boolean;
    allow_forking?: boolean;
    web_commit_signoff_required?: boolean;
    open_issues: number;
    watchers: number;
    master_branch?: string;
    starred_at?: string;
    anonymous_access_enabled?: boolean;
}

type WebhookGithubPullRequestLinksKeys =
    | 'comments'
    | 'commits'
    | 'statuses'
    | 'html'
    | 'issue'
    | 'review_comments'
    | 'review_comment'
    | 'self';

type WebhookGithubPullRequestLinks = {
    [key in WebhookGithubPullRequestLinksKeys]: {
        href: string;
    };
};

export interface IWebhookGithubPullRequest {
    url: string;
    id: number;
    node_id: string;
    html_url: string;
    diff_url: string;
    patch_url: string;
    issue_url: string;
    commits_url: string;
    review_comments_url: string;
    review_comment_url: string;
    comments_url: string;
    statuses_url: string;
    number: number;
    state: 'open' | 'closed';
    locked: boolean;
    title: string;
    user: IWebhookGithubUser;
    body: string | null;
    labels: IWebhookGithubLabel[];
    milestone: IWebhookGithubMilestone | null;
    active_lock_reason?: string | null;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    merged_at: string | null;
    merge_commit_sha: string | null;
    assignee: IWebhookGithubUser | null;
    assignees?: IWebhookGithubUser[] | null;
    requested_reviewers?: IWebhookGithubUser[] | null;
    requested_teams?: IWebhookGithubTeam[] | null;
    head: {
        label: string;
        ref: string;
        repo: IWebhookGithubRepo;
        sha: string;
        user: IWebhookGithubUser;
    };
    base: {
        label: string;
        ref: string;
        sha: string;
        user: IWebhookGithubUser;
        repo: IWebhookGithubRepo;
    };
    _links: WebhookGithubPullRequestLinks;
    author_association: string;
    auto_merge: {
        enabled_by: IWebhookGithubUser;
        merge_method: 'merge' | 'squash' | 'rebase';
        commit_title: string;
        commit_message: string;
    } | null;
    draft?: boolean;
    merged: boolean;
    mergeable: string | null;
    rebasable?: boolean | null;
    mergeable_state: string;
    merged_by: IWebhookGithubUser;
    comments: number;
    review_comments: number;
    mantainer_can_modify: boolean;
    commits: number;
    additions: number;
    deletions: number;
    changed_files: number;
    allow_auto_merge?: boolean;
    allow_update_branch?: boolean;
    delete_branch_on_merge?: boolean;
    merge_commit_message?: 'PR_BODY' | 'PR_TITLE' | 'BLANK';
    merge_commit_title?: 'PR_TITLE' | 'MERGE_MESSAGE';
    squash_merge_commit_message?: 'PR_BODY' | 'COMMIT_MESSAGES' | 'BLANK';
    squash_merge_commit_title?: 'PR_TITLE' | 'COMMIT_OR_PR_TITLE';
    use_squash_pr_title_as_default?: boolean;
}

enum WebhookGithubPullRequestAction {
    ASSIGNED = 'assigned',
    AUTO_MERGE_DISABLED = 'auto_merge_disabled',
    AUTO_MERGE_ENABLED = 'auto_merge_enabled',
    CLOSED = 'closed',
    CONVERTED_TO_DRAFT = 'converted_to_draft',
    DEMILESTONED = 'demilestoned',
    DEQUEUED = 'dequeued',
    EDITED = 'edited',
    ENQUEUED = 'enqueued',
    LABELED = 'labeled',
    LOCKED = 'locked',
    MILESTONED = 'milestoned',
    OPENED = 'opened',
    READY_FOR_REVIEW = 'ready_for_review',
    REOPENED = 'reopened',
    REVIEW_REQUEST_REMOVED = 'review_request_removed',
    REVIEW_REQUETED = 'review_requested',
    SYNCHRONIZE = 'synchronize',
    UNASSIGNED = 'unassigned',
    UNLABELED = 'unlabeled',
    UNLOCKED = 'unlocked',
}

export interface IWebhookGithubPullRequestEvent {
    action: WebhookGithubPullRequestAction;
    enterprise?: any;
    installation?: any;
    number: number;
    organization?: any;
    pull_request?: IWebhookGithubPullRequest;
    issue?: any;
    repository: IWebhookGithubRepo;
    sender: IWebhookGithubUser;
}

type WebhookGithubPullRequestCommentLinksKeys =
    | 'html'
    | 'pull_request'
    | 'self';

type WebhookGithubPullRequestCommentLinks = {
    [key in WebhookGithubPullRequestCommentLinksKeys]: {
        href: string;
    };
};

type WebhookGithubPullRequestCommentReactionKeys =
    | '+1'
    | '-1'
    | 'confused'
    | 'eyes'
    | 'heart'
    | 'hooray'
    | 'laugh'
    | 'rocket';

type WebhookGithubPullRequestCommentReactions = {
    [key in WebhookGithubPullRequestCommentReactionKeys]: number;
};

interface IWebhookGithubPullRequestComment {
    _links: WebhookGithubPullRequestCommentLinks;
    author_association:
        | 'COLLABORATOR'
        | 'CONTRIBUTOR'
        | 'FIRST_TIMER'
        | 'FIRST_TIME_CONTRIBUTOR'
        | 'MANNEQUIN'
        | 'MEMBER'
        | 'NONE'
        | 'OWNER';
    body: string;
    commit_id: string;
    created_at: string;
    diff_hunk: string;
    html_url: string;
    id: number;
    in_reply_to_id?: number;
    line: number | null;
    node_id: string;
    original_commit_id: string;
    original_line: number | null;
    original_position: number;
    original_start_line: number | null;
    path: string;
    position: number | null;
    pull_request_review_id: number | null;
    pull_request_url: string;
    reactions: WebhookGithubPullRequestCommentReactions & {
        total_count: number;
        url: string;
    };
    side: 'LEFT' | 'RIGHT';
    start_line: number | null;
    start_side: 'LEFT' | 'RIGHT' | null;
    subject_type?: 'line' | 'file';
    updated_at: string;
    url: string;
    user: IWebhookGithubUser | null;
}

enum WebhookGithubPullRequestCommentAction {
    CREATED = 'created',
    DELETED = 'deleted',
    EDITED = 'edited',
}

export interface IWebhookGithubPullRequestCommentEvent {
    action: WebhookGithubPullRequestCommentAction;
    comment: IWebhookGithubPullRequestComment;
    enterprise?: any;
    installation?: any;
    organization?: any;
    pull_request?: IWebhookGithubPullRequest;
    issue?: IWebhookGithubIssue;
    repository: IWebhookGithubRepo;
    sender: IWebhookGithubUser;
}

interface IWebhookGithubIssue {
    active_lock_reason: 'resolved' | 'off-topic' | 'too heated' | 'spam' | null;
    assignee: IWebhookGithubUser | null;
    assignees: IWebhookGithubUser[] | null;
    author_association:
        | 'COLLABORATOR'
        | 'CONTRIBUTOR'
        | 'FIRST_TIMER'
        | 'FIRST_TIME_CONTRIBUTOR'
        | 'MANNEQUIN'
        | 'MEMBER'
        | 'NONE'
        | 'OWNER';
    body: string | null;
    closed_at: string | null;
    comments: number;
    comments_url: string;
    created_at: string;
    draft?: boolean;
    events_url: string;
    html_url: string;
    id: number;
    labels: IWebhookGithubLabel[];
    labels_url: string;
    locked: boolean;
    milestone: IWebhookGithubMilestone | null;
    node_id: string;
    number: number;
    performed_via_github_app?: any;
    pull_request?: {
        url: string;
        html_url: string;
        diff_url: string;
        patch_url: string;
    };
    reactions: WebhookGithubPullRequestCommentReactions & {
        total_count: number;
        url: string;
    };
    repository_url: string;
    sub_issues_summary?: {
        total: number;
        completed: number;
        percent_completed: number;
    };
    state: 'open' | 'closed';
    state_reason?: string | null;
    timeline_url?: string;
    title: string;
    updated_at: string;
    url: string;
    user: IWebhookGithubUser | null;
}
