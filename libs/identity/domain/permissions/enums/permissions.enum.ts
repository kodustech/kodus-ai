export enum Action {
    Manage = 'manage', // wildcard for any action
    Create = 'create',
    Read = 'read',
    Update = 'update',
    Delete = 'delete',
}

export enum Role {
    OWNER = 'owner',
    BILLING_MANAGER = 'billing_manager',
    REPO_ADMIN = 'repo_admin',
    CONTRIBUTOR = 'contributor',
}

export enum ResourceType {
    All = 'all',
    PullRequests = 'pull_requests',
    Issues = 'issues',
    Cockpit = 'cockpit',
    Billing = 'billing',
    CodeReviewSettings = 'code_review_settings',
    IssuesSettings = 'issues_settings',
    GitSettings = 'git_settings',
    UserSettings = 'user_settings',
    OrganizationSettings = 'organization_settings',
    PluginSettings = 'plugin_settings',
    Logs = 'logs',
    KodyRules = 'kody_rules',
    TokenUsage = 'token_usage',
    CliReview = 'cli_review',
}
