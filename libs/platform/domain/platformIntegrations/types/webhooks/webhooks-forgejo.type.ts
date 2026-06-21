/**
 * Forgejo/Gitea webhook payload types.
 * Forgejo uses a GitHub-compatible API, so many structures are similar.
 */

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/user.go#L14
export interface IWebhookForgejoUser {
    id: number;
    source_id: number;
    login: string;
    login_name: string;
    full_name: string;
    email: string;
    avatar_url: string;
    html_url: string;
    language: string;
    location: string;
    pronouns: string;
    website: string;
    description: string;
    visibility: 'public' | 'limited' | 'private';
    is_admin: boolean;
    restricted: boolean;
    active: boolean;
    prohibit_login: boolean;
    last_login?: string; // dates (ISO 8601 strings)
    created?: string; // dates (ISO 8601 strings)
    followers_count: number;
    following_count: number;
    starred_repos_count: number;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/issue_label.go#L13
export interface IWebhookForgejoLabel {
    id: number;
    name: string;
    color: string;
    description: string;
    url: string;
    exclusive?: boolean;
    is_archived?: boolean;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/issue_milestone.go#L11
export interface IWebhookForgejoMilestone {
    id: number;
    title: string;
    description: string;
    state: WebhookForgejoMilestoneState;
    open_issues: number;
    closed_issues: number;
    created_at: string; // ISO 8601 date-time
    updated_at?: string; // ISO 8601 date-time
    closed_at?: string; // ISO 8601 date-time
    due_on?: string; // ISO 8601 date-time
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/issue.go#L21
export enum WebhookForgejoMilestoneState {
    OPEN = 'open',
    CLOSED = 'closed',
    ALL = 'all',
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/repo.go#L50
export interface IWebhookForgejoRepository {
    id: number;
    owner: IWebhookForgejoUser;
    name: string;
    full_name: string;
    description: string;
    empty: boolean;
    private: boolean;
    fork: boolean;
    template: boolean;
    parent: IWebhookForgejoRepository | null;
    mirror: boolean;
    size: number;
    language: string;
    languages_url: string;
    html_url: string;
    url: string;
    link: string;
    ssh_url: string;
    clone_url: string;
    original_url: string;
    website: string;
    stars_count: number;
    forks_count: number;
    watchers_count: number;
    open_issues_count: number;
    open_pr_counter: number;
    release_counter: number;
    default_branch: string;
    archived: boolean;
    created_at: string;
    updated_at: string;
    archived_at: string;
    permissions?: IWebhookForgejoPermission;
    has_issues: boolean;
    internal_tracker?: IWebhookForgejoInternalTracker;
    external_tracker?: IWebhookForgejoExternalTracker;
    has_wiki: boolean;
    external_wiki?: IWebhookForgejoExternalWiki;
    wiki_branch?: string;
    globally_editable_wiki: boolean;
    has_pull_requests: boolean;
    has_projects: boolean;
    has_releases: boolean;
    has_packages: boolean;
    has_actions: boolean;
    ignore_whitespace_conflicts: boolean;
    allow_merge_commits: boolean;
    allow_rebase: boolean;
    allow_rebase_explicit: boolean;
    allow_squash_merge: boolean;
    allow_fast_forward_only_merge: boolean;
    allow_rebase_update: boolean;
    default_delete_branch_after_merge: boolean;
    default_merge_style: string;
    default_allow_maintainer_edit: boolean;
    default_update_style: string;
    avatar_url: string;
    internal: boolean;
    mirror_interval: string;
    object_format_name: 'sha1' | 'sha256';
    mirror_updated?: string;
    repo_transfer?: IWebhookForgejoRepoTransfer;
    topics: string[];
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/repo.go#L12
export interface IWebhookForgejoPermission {
    admin: boolean;
    push: boolean;
    pull: boolean;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/repo.go#L20
export interface IWebhookForgejoInternalTracker {
    enable_time_tracker: boolean;
    allow_only_contributors_to_track_time: boolean;
    enable_issue_dependencies: boolean;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/repo.go#L31
export interface IWebhookForgejoExternalTracker {
    external_tracker_url: string;
    external_tracker_format: string;
    external_tracker_style: string;
    external_tracker_regexp_pattern: string;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/repo.go#L44
export interface IWebhookForgejoExternalWiki {
    external_wiki_url: string;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/org_team.go#L8
export interface IWebhookForgejoTeam {
    id: number;
    name: string;
    description: string;
    organization?: IWebhookForgejoOrganization;
    includes_all_repositories: boolean;
    permission: 'none' | 'read' | 'write' | 'admin' | 'owner';
    units?: string[];
    units_map?: Record<string, string>;
    can_create_org_repo: boolean;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/org.go#L7
export interface IWebhookForgejoOrganization {
    id: number;
    name: string;
    full_name: string;
    email: string;
    avatar_url: string;
    description: string;
    website: string;
    location: string;
    visibility: string;
    repo_admin_change_team_access: boolean;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/repo.go#L422
export interface IWebhookForgejoRepoTransfer {
    doer?: IWebhookForgejoUser;
    recipient?: IWebhookForgejoUser;
    teams?: IWebhookForgejoTeam[];
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/pull.go#L65
export interface IWebhookForgejoPullRequestBranchInfo {
    label: string;
    ref: string;
    sha: string;
    repo_id: number;
    repo: IWebhookForgejoRepository;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/pull.go#L11
export interface IWebhookForgejoPullRequest {
    id: number;
    url: string;
    number: number;
    user: IWebhookForgejoUser;
    title: string;
    body: string;
    labels: IWebhookForgejoLabel[];
    milestone: IWebhookForgejoMilestone | null;
    assignee: IWebhookForgejoUser | null;
    assignees: IWebhookForgejoUser[] | null;
    requested_reviewers: IWebhookForgejoUser[] | null;
    requested_reviewers_teams: IWebhookForgejoTeam[] | null;
    state: WebhookForgejoMilestoneState;
    draft: boolean;
    is_locked: boolean;
    comments: number;
    review_comments: number;
    additions: number;
    deletions: number;
    changed_files: number;
    html_url: string;
    diff_url: string;
    patch_url: string;
    mergeable: boolean;
    merged: boolean;
    merged_at: string | null;
    merge_commit_sha: string | null;
    merged_by: IWebhookForgejoUser | null;
    allow_maintainer_edit: boolean;
    base: IWebhookForgejoPullRequestBranchInfo;
    head: IWebhookForgejoPullRequestBranchInfo;
    merge_base: string;
    due_date: string | null;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    pin_order: number;
    flow: number;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/issue_comment.go#L11
export interface IWebhookForgejoComment {
    id: number;
    html_url: string;
    pull_request_url: string;
    issue_url: string;
    user: IWebhookForgejoUser;
    original_author: string;
    original_author_id: number;
    body: string;
    assets: IWebhookForgejoAttachment[];
    created_at: string;
    updated_at: string;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/attachment.go#L12
export interface IWebhookForgejoAttachment {
    id: number;
    name: string;
    size: number;
    download_count: number;
    created_at: string;
    uuid: string;
    browser_download_url: string;
    type: 'attachment' | 'external';
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/pull_review.go#L29
export interface IWebhookForgejoReview {
    id: number;
    user: IWebhookForgejoUser;
    team?: IWebhookForgejoTeam;
    state: WebhookForgejoReviewState;
    body: string;
    commit_id: string;
    stale: boolean;
    official: boolean;
    dismissed: boolean;
    comments_count: number;
    submitted_at: string;
    updated_at: string;
    html_url: string;
    pull_request_url: string;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/pull_review.go#L13
export enum WebhookForgejoReviewState {
    APPROVED = 'APPROVED',
    PENDING = 'PENDING',
    COMMENT = 'COMMENT',
    REQUEST_CHANGES = 'REQUEST_CHANGES',
    REQUEST_REVIEW = 'REQUEST_REVIEW',
    UNKNOWN = '',
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L86
export interface IWebhookForgejoCommit {
    id: string;
    message: string;
    url: string;
    author: IWebhookForgejoCommitUser;
    committer: IWebhookForgejoCommitUser;
    verification?: IWebhookForgejoPayloadCommitVerification;
    timestamp: string;
    added: string[];
    removed: string[];
    modified: string[];
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L74
export interface IWebhookForgejoCommitUser {
    name: string;
    email: string;
    username: string;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L102
export interface IWebhookForgejoPayloadCommitVerification {
    verified: boolean;
    reason: string;
    signature: string;
    signer?: IWebhookForgejoCommitUser;
    payload: string;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L311
export interface IWebhookForgejoPushEvent {
    ref: string;
    before: string;
    after: string;
    compare_url: string;
    commits: IWebhookForgejoCommit[];
    total_commits: number;
    head_commit: IWebhookForgejoCommit | null;
    repository: IWebhookForgejoRepository;
    pusher: IWebhookForgejoCommitUser;
    sender: IWebhookForgejoUser;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L359
export interface IWebhookForgejoPullRequestEvent {
    action: WebhookForgejoHookIssueAction;
    number: number;
    changes?: IWebhookForgejoChangesPayload;
    pull_request: IWebhookForgejoPullRequest;
    repository: IWebhookForgejoRepository;
    sender: IWebhookForgejoUser;
    commit_id?: string;
    review?: IWebhookForgejoReview;
    label?: IWebhookForgejoLabel;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L291
export enum WebhookForgejoHookIssueAction {
    OPENED = 'opened',
    CLOSED = 'closed',
    REOPENED = 'reopened',
    EDITED = 'edited',
    ASSIGNED = 'assigned',
    UNASSIGNED = 'unassigned',
    LABEL_UPDATED = 'label_updated',
    LABEL_CLEARED = 'label_cleared',
    SYNCHRONIZED = 'synchronized', // forgejo uses synchronized instead of synchronize
    MILESTONED = 'milestoned',
    DEMILESTONED = 'demilestoned',
    REVIEWED = 'reviewed',
    REVIEW_REQUESTED = 'review_requested',
    REVIEW_REQUEST_REMOVED = 'review_request_removed',
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L204
export interface IWebhookForgejoIssueCommentEvent {
    action: WebhookForgejoCommentAction;
    issue: IWebhookForgejoIssue;
    pull_request?: IWebhookForgejoPullRequest;
    comment: IWebhookForgejoComment;
    changes?: IWebhookForgejoChangesPayload;
    repository: IWebhookForgejoRepository;
    sender: IWebhookForgejoUser;
    is_pull: boolean;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L197
export enum WebhookForgejoCommentAction {
    CREATED = 'created',
    EDITED = 'edited',
    DELETED = 'deleted',
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/issue.go#L46
export interface IWebhookForgejoIssue {
    id: number;
    url: string;
    html_url: string;
    number: number;
    user: IWebhookForgejoUser;
    original_author: string;
    original_author_id: number;
    title: string;
    body: string;
    ref: string;
    assets: IWebhookForgejoAttachment[];
    labels: IWebhookForgejoLabel[];
    milestone: IWebhookForgejoMilestone | null;
    assignee: IWebhookForgejoUser | null;
    assignees: IWebhookForgejoUser[] | null;
    state: WebhookForgejoMilestoneState;
    is_locked: boolean;
    comments: number;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
    due_date: string | null;
    pull_request?: IWebhookForgejoPullRequestMeta;
    repository?: IWebhookForgejoRepositoryMeta;
    pin_order: number;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/issue.go#L29
export interface IWebhookForgejoPullRequestMeta {
    merged: boolean;
    merged_at: string | null;
    draft: boolean;
    html_url: string;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/issue.go#L37
export interface IWebhookForgejoRepositoryMeta {
    id: number;
    name: string;
    owner: string;
    full_name: string;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L340
export interface IWebhookForgejoChangesFromPayload {
    from: string;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L345
export interface IWebhookForgejoChangesPayload {
    title?: IWebhookForgejoChangesFromPayload;
    body?: IWebhookForgejoChangesFromPayload;
    ref?: IWebhookForgejoChangesFromPayload;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L396
export interface IWebhookForgejoReviewPayload {
    type: string;
    content: string;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L359
export interface IWebhookForgejoPullRequestReviewEvent {
    action: WebhookForgejoHookIssueAction;
    number: number;
    changes?: IWebhookForgejoChangesPayload;
    pull_request: IWebhookForgejoPullRequest;
    requested_reviewer?: IWebhookForgejoUser;
    repository: IWebhookForgejoRepository;
    sender: IWebhookForgejoUser;
    commit_id: string;
    review: IWebhookForgejoReviewPayload;
    label?: IWebhookForgejoLabel;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/structs/hook.go#L395
export interface IWebhookForgejoReviewPayload {
    type: string;
    content: string;
}

// @see https://codeberg.org/forgejo/forgejo/src/branch/forgejo/modules/actions/github.go#L10
export enum WebhookForgejoEvent {
    PULL_REQUEST = 'pull_request',
    PULL_REQUEST_TARGET = 'pull_request_target',
    PULL_REQUEST_REVIEW_COMMENT = 'pull_request_review_comment',
    PULL_REQUEST_REVIEW = 'pull_request_review',
    REGISTRY_PACKAGE = 'registry_package',
    CREATE = 'create',
    DELETE = 'delete',
    FORK = 'fork',
    PUSH = 'push',
    ISSUES = 'issues',
    ISSUE_COMMENT = 'issue_comment',
    RELEASE = 'release',
    PULL_REQUEST_COMMENT = 'pull_request_comment',
    GOLLUM = 'gollum',
    SCHEDULE = 'schedule',
    WORKFLOW_DISPATCH = 'workflow_dispatch',
}
