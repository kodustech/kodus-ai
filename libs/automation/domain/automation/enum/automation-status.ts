export enum AutomationStatus {
    PENDING = 'pending',

    IN_PROGRESS = 'in_progress',

    SUCCESS = 'success',
    ERROR = 'error',
    PARTIAL_ERROR = 'partial_error',
    SKIPPED = 'skipped',
}

export enum AutomationMessage {
    NO_CONFIG_IN_CONTEXT = 'No code-review configuration found in the current context.',
    NO_FILES_AFTER_IGNORE = 'No files remain after applying ignore patterns.',
    TOO_MANY_FILES = `Too many files to analyze.`,
    NO_FILES_IN_PR = 'No changed files in this pull request.',
    FAILED_RESOLVE_CONFIG = 'Unable to load or resolve the review configuration.',
    SKIPPED_BY_BASIC_RULES = `Skipped by baseline configuration rules.`,
    PROCESSING_MANUAL = 'Processing due to manual command.',
    PROCESSING_AUTOMATIC = 'Processing in automatic mode.',
    FIRST_REVIEW_MANUAL = 'Starting first review (manual mode).',
    MANUAL_REQUIRED_TO_START = `Manual mode requires @kody start-review.`,
    FIRST_REVIEW_AUTO_PAUSE = 'Starting first review (auto-pause mode).',
    PR_PAUSED_NEED_RESUME = `PR is paused — use @kody start-review to resume.`,
    PR_PAUSED_BURST_PUSHES = `PR is paused due to multiple pushes in a short time window.`,
    PROCESSING_AUTO_PAUSE = 'Processing in auto-pause mode.',
    CONFIG_VALIDATION_ERROR = 'Error during configuration validation.',
    NO_NEW_COMMITS_SINCE_LAST = 'No new commits since the last run.',
    ONLY_MERGE_COMMITS_SINCE_LAST = 'Only merge commits since the last run.',
    PROVIDER_RATE_LIMITED = 'The Git provider rate-limited the request; the review was not run.',
    USER_IGNORED = 'User is ignored by configuration.',
    VALIDATION_FAILED = 'Prerequisites validation failed.',
}
