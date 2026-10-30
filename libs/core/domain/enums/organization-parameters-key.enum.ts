export enum OrganizationParametersKey {
    CATEGORY_WORKITEM_TYPES = 'category_workitems_type',
    TIMEZONE_CONFIG = 'timezone_config',
    REVIEW_MODE_CONFIG = 'review_mode_config',
    KODY_FINE_TUNING_CONFIG = 'kody_fine_tuning_config',
    AUTO_JOIN_CONFIG = 'auto_join_config',
    BYOK_CONFIG = 'byok_config',
    COCKPIT_METRICS_VISIBILITY = 'cockpit_metrics_visibility',
    AUTO_LICENSE_ASSIGNMENT = 'auto_license_assignment',
    CODE_REVIEW_PRESET = 'code_review_preset',
    LICENSE_KEY = 'license_key',
    LICENSE_ASSIGNED_USERS = 'license_assigned_users',
    FIRST_REVIEW_AT = 'first_review_at',
    SPEND_LIMIT_CONFIG = 'spend_limit_config',
    /**
     * Preview-environment (Alpha) app secrets — the customer's `.env` values
     * the booted app needs. Stored encrypted, keyed by repo:
     * `{ [repositoryId]: { ENV_NAME: <encrypted> } }`. Values are never
     * returned by the API (only a "configured" descriptor).
     */
    ENVIRONMENT_SECRETS = 'environment_secrets',
    /**
     * Preview-environment (Alpha) infrastructure — WHERE the ephemeral VM is
     * provisioned. Org-level so self-hosted customers point at their own cloud
     * from the UI: `{ provider, token: <encrypted>, region?, serverType? }`.
     * The token is never returned by the API. Absent → the server-level
     * PREVIEW_VM_TOKEN/HCLOUD_TOKEN env fallback applies (cloud alpha).
     */
    ENVIRONMENT_INFRA = 'environment_infra',
    /**
     * Kody Runtime golden-snapshot registry (warm boot). Per-repo baked VM
     * image + the fingerprint it was built from, so a PR warm-boots from the
     * snapshot instead of cold-installing every time:
     * `{ [repositoryId]: { imageId, key, region, createdAt } }`. Rebuilt only
     * when the fingerprint (playbook + lockfiles) changes. Not secret.
     */
    ENVIRONMENT_SNAPSHOTS = 'environment_snapshots',
    GLOBAL_RULES_SOURCE_REPOSITORIES = 'global_rules_source_repositories',
}
