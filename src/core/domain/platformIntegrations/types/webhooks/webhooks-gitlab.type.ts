type LiteralUnion<T extends U, U = string> = T | (U & { _?: never });

interface Compare<T> {
    previous: T;
    current: T;
}

interface IWebhookGitlabStDiff {
    diff: string;
    new_path: string;
    old_path: string;
    a_mode: string;
    b_mode: string;
    new_file: boolean;
    renamed_file: boolean;
    deleted_file: boolean;
}

interface IWebhookGitlabIssue {
    id: number;
    iid: number;
    title: string;
    assignee_ids: number[];
    assignee_id: number;
    author_id: number;
    project_id: number;
    created_at: string;
    updated_at: string;
    position: number;
    branch_name: string;
    description: string;
    milestone_id: number;
    state: LiteralUnion<'opened'>;
    severity?: LiteralUnion<'unknown'>;
}

interface IWebhookGitlabSnippet {
    id: number;
    title: string;
    content: string;
    author_id: number;
    project_id: number;
    created_at: string;
    updated_at: string;
    file_name: string;
    expires_at: string;
    type: string;
    visibility_level: number;
}

interface IWebhookGitlabCommit {
    id: string;
    title?: string;
    message: string;
    timestamp: string;
    url: string;
    author: IWebhookGitlabAuthor;
}

interface IWebhookGitlabLabel {
    id: number;
    title: string;
    color: string;
    project_id: number;
    created_at: string;
    updated_at: string;
    template: boolean;
    description: string;
    type: 'ProjectLabel';
    group_id: number;
}

interface IWebhookGitlabChanges {
    milestone_id: Compare<number | null>;
    updated_by_id: Compare<number | null>;
    updated_at: Compare<string>;
    draft: Compare<boolean>;
    labels: Compare<IWebhookGitlabLabel[]>;
    last_edited_at: Compare<string | null>;
    last_edited_by_id: Compare<number | null>;
    assignees: Compare<IWebhookGitlabUser[]>;
    reviewers: Compare<IWebhookGitlabUser[]>;
    description: Compare<string>;
}

interface IWebhookGitlabMergeRequest {
    id: number;
    target_branch: string;
    source_branch: string;
    source_project_id: number;
    author_id: number;
    assignee_id: number;
    title: string;
    created_at: string;
    updated_at: string;
    milestone_id: number;
    state: string;
    merge_status:
        | 'can_be_merged'
        | 'cannot_be_merged'
        | 'cannot_be_merged_recheck'
        | 'checking';
    target_project_id: number;
    iid: number;
    description: string;
    position: number;
    source: IWebhookGitlabProject;
    target: IWebhookGitlabProject;
    last_commit: IWebhookGitlabCommit;
    work_in_progress: boolean;
    assignee: IWebhookGitlabUser;
    approved_by_ids?: number[];
    approver_ids?: number[];
}

interface IWebhookGitlabUser {
    id: number;
    name: string;
    username: string;
    avatar_url: string;
    email?: string;
}

interface IWebhookGitlabAuthor {
    name: string;
    email: string;
}

interface IWebhookGitlabProject {
    id?: number;
    name: string;
    description: string;
    web_url: string;
    avatar_url: string;
    git_ssh_url: string;
    git_http_url: string;
    namespace: string;
    visibility_level: number;
    path_with_namespace: string;
    default_branch: string;
    homepage: string;
    url: string;
    ssh_url: string;
    http_url: string;
}

interface IWebhookGitlabRepository {
    name: string;
    url: string;
    description: string;
    homepage: string;
}

enum WebhookGitlabMergeRequestState {
    OPENED = 'opened',
    CLOSED = 'closed',
    MERGED = 'merged',
    LOCKED = 'locked',
}

enum WebhookGitlabMergeRequestAction {
    OPEN = 'open',
    CLOSE = 'close',
    REOPEN = 'reopen',
    UPDATE = 'update',
    APPROVED = 'approved',
    UNAPPROVED = 'unapproved',
    APPROVAL = 'approval',
    UNAPPROVAL = 'unapproval',
    MERGE = 'merge',
}

interface IWebhookGitlabMergeRequestAttributes {
    id: number;
    iid: number;
    target_branch: string;
    source_branch: string;
    source_project_id: number;
    author_id: number;
    assignee_ids: number[];
    reviewer_ids: number[];
    title: string;
    created_at: string;
    updated_at: string;
    last_edited_at: string;
    last_edited_by_id: number;
    milestone_id: number | null;
    state_id: number;
    state: WebhookGitlabMergeRequestState;
    blocking_discussions_resolved: boolean;
    work_in_progress: boolean;
    draft: boolean;
    first_contribution: boolean;
    target_project_id: number;
    description: string;
    prepared_at: string;
    total_time_spent: number;
    time_change: number;
    human_total_time_spent: string | null;
    human_time_change: string | null;
    human_time_estimate: string | null;
    url: string;
    source: IWebhookGitlabProject;
    target: IWebhookGitlabProject;
    last_commit: IWebhookGitlabCommit;
    labels: IWebhookGitlabLabel[];
    action: WebhookGitlabMergeRequestAction;
    detailed_merge_status: 'checking' | 'mergeable' | string;
}

interface IWebhookGitlabCommentAttributes {
    id: number;
    note: string;
    noteable_type: string;
    author_id: number;
    created_at: string;
    updated_at: string;
    project_id: number;
    attachment: any;
    line_code: string;
    commit_id: string;
    noteable_id: number | null;
    system: boolean;
    st_diff: IWebhookGitlabStDiff;
    url: string;
    description?: string;
    action: 'create' | 'update';
}

export interface IWebhookGitlabMergeRequestEvent {
    object_kind: 'merge_request';
    event_type: 'merge_request';
    user: IWebhookGitlabUser;
    project: IWebhookGitlabProject;
    repository: IWebhookGitlabRepository;
    object_attributes: IWebhookGitlabMergeRequestAttributes;
    labels: IWebhookGitlabLabel[];
    changes: Partial<IWebhookGitlabChanges>;
    assignees: IWebhookGitlabUser[];
    reviewers: IWebhookGitlabUser[];
}

export interface IWebhookGitlabCommentEvent {
    object_kind: 'note';
    event_type: 'note';
    user: IWebhookGitlabUser;
    project_id: number;
    project: IWebhookGitlabProject;
    repository: IWebhookGitlabRepository;
    object_attributes: IWebhookGitlabCommentAttributes;
    commit?: IWebhookGitlabCommit;
    merge_request?: IWebhookGitlabMergeRequest;
    issue?: IWebhookGitlabIssue;
    snippet?: IWebhookGitlabSnippet;
}
