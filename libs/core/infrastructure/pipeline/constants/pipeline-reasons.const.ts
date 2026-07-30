import { PipelineReason } from '../interfaces/pipeline-reason.interface';

export const PipelineReasons = {
    CONFIG: {
        DISABLED: {
            message: 'Automated Review is disabled',
            action: "Enable 'Automated Code Review' in General Settings",
        } as PipelineReason,
        IGNORED_TITLE: {
            message: 'Title Ignored',
            action: "Remove keywords defined in 'Ignore title keywords' setting",
        } as PipelineReason,
        DRAFT: {
            message: 'Draft PR Skipped',
            action: "Enable 'Running on Draft Pull Requests' in settings or mark as Ready",
        } as PipelineReason,
        BRANCH_MISMATCH: {
            message: 'Branch Mismatch',
            action: 'Review only runs on specific target branches',
        } as PipelineReason,
    },
    FILES: {
        NO_CHANGES: {
            message: 'No Files Changed',
        } as PipelineReason,
        ALL_IGNORED: {
            message: 'All Files Ignored',
            action: "Check your 'Ignored files' patterns in settings",
        } as PipelineReason,
        TOO_MANY: {
            message: 'Too Many Files',
            action: 'Reduce PR size for better review quality',
        } as PipelineReason,
    },
    COMMITS: {
        NO_NEW: {
            message: 'No New Commits',
            description: 'We already reviewed the latest changes',
        } as PipelineReason,
        ONLY_MERGE: {
            message: 'Only Merge Commits',
            description: 'Merge commits are skipped to avoid noise',
        } as PipelineReason,
        PROVIDER_RATE_LIMITED: {
            message: 'Provider Rate Limited',
            description:
                'The Git provider throttled the commit fetch (HTTP 429); the review was not run',
            action: 'Re-run the review once the provider rate-limit window refills',
        } as PipelineReason,
    },
    PREREQUISITES: {
        CLOSED: {
            message: 'PR is Closed',
        } as PipelineReason,
        LOCKED: {
            message: 'PR is Locked',
        } as PipelineReason,
        MISSING_DATA: {
            message: 'Invalid Context Data',
            description: 'Required PR/Repo metadata missing',
        } as PipelineReason,
        NO_LICENSE: {
            message: 'No Active Subscription',
            action: 'Check subscription settings',
        } as PipelineReason,
        BYOK_MISSING: {
            message: 'BYOK Configuration Required',
            action: 'Configure API Keys in Settings',
        } as PipelineReason,
        PLAN_LIMIT: {
            message: 'Plan Limit Exceeded',
            action: 'Upgrade plan to continue',
        } as PipelineReason,
        USER_NO_LICENSE: {
            message: 'User Not Licensed',
            action: 'Assign seat to user',
        } as PipelineReason,
    },
    SUGGESTIONS: {
        VALIDATION_FAILED: {
            message: 'Suggestion Validation Failed',
            action: 'Contact support if this persists',
        } as PipelineReason,
        NO_RESULTS: {
            message: 'No Validated Suggestions',
            description: 'Validation filtered out all suggestions',
        } as PipelineReason,
    },
    FINE_TUNING: {
        DISABLED: {
            message: 'Fine-Tuning Disabled',
            description: 'Context skipped as per configuration',
        } as PipelineReason,
        NO_MATCHES: {
            message: 'No Matching Examples',
            description: 'No relevant fine-tuning examples found',
        } as PipelineReason,
    },
};
