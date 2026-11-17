import { CommandError } from './command-errors.js';
import { parseRepositoryPatternList } from './repo-settings-schema.js';

export type ReviewSettingType =
    'boolean' | 'number' | 'string' | 'enum' | 'string[]' | 'json';

export type ReviewSettingSection =
    | 'general'
    | 'review-scope'
    | 'custom-prompts'
    | 'suggestion-control'
    | 'pr-summary'
    | 'kody-rules'
    | 'business-logic'
    | 'linked-repositories';

export interface ReviewSettingDefinition {
    key: string;
    type: ReviewSettingType;
    section: ReviewSettingSection;
    description: string;
    values?: readonly string[];
    maxLength?: number;
}

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

/**
 * Every setting the Settings > Code Review pages edit, keyed by its path in
 * CODE_REVIEW_CONFIG. Types and allowed values follow the API's validation
 * (libs/organization/dtos/create-or-update-code-review-parameter.dto.ts), the
 * contract a save is checked against. Not here, on purpose:
 * - customAgents: `kodus agents`; byokModelId/byokModel: `kodus config remote model`.
 * - businessLogic.taskSource / taskSourceTool: connecting a task source.
 * - customMessages and language: stored outside CODE_REVIEW_CONFIG.
 * - knowledge (Skills page): a revision-guarded list of repository files.
 * - codeReviewVersion, suggestionControl.limitationType/maxSuggestions,
 *   v2PromptOverrides.level.*: in the config type, but on no settings page.
 */
export const REVIEW_SETTINGS: readonly ReviewSettingDefinition[] = [
    // General
    {
        key: 'automatedReviewActive',
        type: 'boolean',
        section: 'general',
        description: 'Run reviews automatically on pull requests.',
    },
    {
        key: 'reviewCadence.type',
        type: 'enum',
        section: 'general',
        values: ['automatic', 'manual', 'auto_pause'],
        description: 'When new pushes trigger a review.',
    },
    {
        key: 'reviewCadence.timeWindow',
        type: 'number',
        section: 'general',
        description: 'auto_pause: window in minutes for counting pushes.',
    },
    {
        key: 'reviewCadence.pushesToTrigger',
        type: 'number',
        section: 'general',
        description: 'auto_pause: pushes within the window that pause reviews.',
    },
    {
        key: 'runOnDraft',
        type: 'boolean',
        section: 'general',
        description: 'Review draft pull requests.',
    },
    {
        key: 'baseBranches',
        type: 'string[]',
        section: 'general',
        description: 'Base branch patterns that get reviewed.',
    },
    {
        key: 'ignorePaths',
        type: 'string[]',
        section: 'general',
        description: 'File glob patterns Kody ignores.',
    },
    {
        key: 'ignoredTitleKeywords',
        type: 'string[]',
        section: 'general',
        description: 'Pull request title keywords that skip the review.',
    },
    {
        key: 'showStatusFeedback',
        type: 'boolean',
        section: 'general',
        description: 'Show review status feedback on the pull request.',
    },
    {
        key: 'pullRequestApprovalActive',
        type: 'boolean',
        section: 'general',
        description: 'Approve the pull request when the review finds nothing.',
    },
    {
        key: 'approvalLabels',
        type: 'string[]',
        section: 'general',
        description: 'Only approve pull requests carrying one of these labels.',
    },
    {
        key: 'approvalAuthors',
        type: 'string[]',
        section: 'general',
        description: 'Only approve pull requests from these authors.',
    },
    {
        key: 'approvalRiskActive',
        type: 'boolean',
        section: 'general',
        description:
            'Hold risky pull requests for a human instead of approving.',
    },
    {
        key: 'approvalRiskInstructions',
        type: 'string',
        section: 'general',
        maxLength: 4000,
        description: 'What counts as risky, in your words.',
    },
    {
        key: 'approvalSensitivePaths',
        type: 'string[]',
        section: 'general',
        description: 'Paths that always need a human approval.',
    },
    {
        key: 'isRequestChangesActive',
        type: 'boolean',
        section: 'general',
        description: 'Request changes when the review finds critical issues.',
    },
    {
        key: 'kodusConfigFileOverridesWebPreferences',
        type: 'boolean',
        section: 'general',
        description:
            'Let kodus-config.yml in the repository override these settings.',
    },
    {
        key: 'enableCommittableSuggestions',
        type: 'boolean',
        section: 'general',
        description: 'Post suggestions the author can commit in one click.',
    },
    // What to review
    {
        key: 'reviewOptions.bug',
        type: 'boolean',
        section: 'review-scope',
        description: 'Review for bugs.',
    },
    {
        key: 'reviewOptions.performance',
        type: 'boolean',
        section: 'review-scope',
        description: 'Review for performance issues.',
    },
    {
        key: 'reviewOptions.security',
        type: 'boolean',
        section: 'review-scope',
        description: 'Review for security issues.',
    },
    {
        key: 'reviewOptions.business_logic',
        type: 'boolean',
        section: 'review-scope',
        description: 'Check the change against its task (Business Logic).',
    },
    {
        key: 'repoInstructionsEnabled',
        type: 'boolean',
        section: 'review-scope',
        description:
            'Check changes against CLAUDE.md / AGENTS.md / .cursor/rules.',
    },
    {
        key: 'deterministicEvidence.ciChecks',
        type: 'boolean',
        section: 'review-scope',
        description: 'Read the CI results your pipeline already produced.',
    },
    {
        key: 'deterministicEvidence.tools.secrets',
        type: 'boolean',
        section: 'review-scope',
        description: 'Scan changed files for credentials.',
    },
    {
        key: 'deterministicEvidence.tools.dependencies',
        type: 'boolean',
        section: 'review-scope',
        description: 'Check added or bumped dependencies for known CVEs.',
    },
    {
        key: 'v2PromptOverrides.categories.descriptions.bug',
        type: 'string',
        section: 'review-scope',
        description: 'What Kody looks for under bugs.',
    },
    {
        key: 'v2PromptOverrides.categories.descriptions.performance',
        type: 'string',
        section: 'review-scope',
        description: 'What Kody looks for under performance.',
    },
    {
        key: 'v2PromptOverrides.categories.descriptions.security',
        type: 'string',
        section: 'review-scope',
        description: 'What Kody looks for under security.',
    },
    {
        key: 'v2PromptOverrides.severity.flags.critical',
        type: 'string',
        section: 'review-scope',
        description: 'What makes an issue critical.',
    },
    {
        key: 'v2PromptOverrides.severity.flags.high',
        type: 'string',
        section: 'review-scope',
        description: 'What makes an issue high.',
    },
    {
        key: 'v2PromptOverrides.severity.flags.medium',
        type: 'string',
        section: 'review-scope',
        description: 'What makes an issue medium.',
    },
    {
        key: 'v2PromptOverrides.severity.flags.low',
        type: 'string',
        section: 'review-scope',
        description: 'What makes an issue low.',
    },
    // Custom prompts
    {
        key: 'v2PromptOverrides.generation.main',
        type: 'string',
        section: 'custom-prompts',
        description: 'Extra instructions added to every review.',
    },
    // Suggestion control
    {
        key: 'suggestionControl.groupingMode',
        type: 'enum',
        section: 'suggestion-control',
        values: ['minimal', 'full'],
        description: 'How suggestions are grouped into comments.',
    },
    {
        key: 'suggestionControl.severityLevelFilter',
        type: 'enum',
        section: 'suggestion-control',
        values: SEVERITIES,
        description: 'Minimum severity a suggestion needs to be posted.',
    },
    {
        key: 'suggestionControl.applyFiltersToKodyRules',
        type: 'boolean',
        section: 'suggestion-control',
        description: 'Apply the severity filter to Kody Rules findings too.',
    },
    ...SEVERITIES.map((severity): ReviewSettingDefinition => ({
        key: `suggestionControl.severityLimits.${severity}`,
        type: 'number',
        section: 'suggestion-control',
        description: `Maximum ${severity} suggestions per review (0 = no limit).`,
    })),
    // PR summary
    {
        key: 'summary.generatePRSummary',
        type: 'boolean',
        section: 'pr-summary',
        description: 'Write a summary into the pull request description.',
    },
    {
        key: 'summary.behaviourForExistingDescription',
        type: 'enum',
        section: 'pr-summary',
        values: ['replace', 'concatenate', 'complement'],
        description: 'What to do with a description the author already wrote.',
    },
    {
        key: 'summary.behaviourForNewCommits',
        type: 'enum',
        section: 'pr-summary',
        values: ['none', 'replace', 'concatenate'],
        description: 'What to do with the summary when new commits arrive.',
    },
    {
        key: 'summary.customInstructions',
        type: 'string',
        section: 'pr-summary',
        description: 'Instructions for how the summary is written.',
    },
    // Kody Rules
    {
        key: 'kodyRulesGeneratorEnabled',
        type: 'boolean',
        section: 'kody-rules',
        description: 'Let Kody suggest new rules from review feedback.',
    },
    {
        key: 'kodyRulesAutoPauseEnabled',
        type: 'boolean',
        section: 'kody-rules',
        description: 'Pause rules whose findings keep getting rejected.',
    },
    {
        key: 'kodyLearningExcludedReviewers',
        type: 'string[]',
        section: 'kody-rules',
        description: 'Reviewers whose comments Kody does not learn from.',
    },
    {
        key: 'kodyKnowledgeApproval.enabled',
        type: 'boolean',
        section: 'kody-rules',
        description: 'Hold learned rules and memories for approval.',
    },
    // Business Logic
    {
        key: 'businessLogic.taskIdPattern',
        type: 'string',
        section: 'business-logic',
        maxLength: 200,
        description: 'Regex that finds the task id in a pull request.',
    },
    {
        key: 'businessLogic.criteriaLocation',
        type: 'enum',
        section: 'business-logic',
        values: ['auto', 'heading', 'field'],
        description: 'Where the acceptance criteria live in the task.',
    },
    {
        key: 'businessLogic.criteriaHeading',
        type: 'string',
        section: 'business-logic',
        description: 'criteriaLocation=heading: the heading that holds them.',
    },
    {
        key: 'businessLogic.criteriaField',
        type: 'string',
        section: 'business-logic',
        description: 'criteriaLocation=field: the field that holds them.',
    },
    {
        key: 'businessLogic.teamGuidance',
        type: 'string',
        section: 'business-logic',
        maxLength: 2000,
        description: 'Guidance added to what Kody follows.',
    },
    {
        key: 'businessLogic.commentWhenMet',
        type: 'boolean',
        section: 'business-logic',
        description: 'Comment on pull requests that meet their task.',
    },
    {
        key: 'businessLogic.recheckOn',
        type: 'enum',
        section: 'business-logic',
        values: ['failing', 'push', 'request'],
        description: 'When a push re-checks a pull request already checked.',
    },
    {
        key: 'businessLogic.requireTask',
        type: 'boolean',
        section: 'business-logic',
        description: 'Fail pull requests that reference no existing task.',
    },
    // Linked repositories
    {
        key: 'linkedRepositories',
        type: 'json',
        section: 'linked-repositories',
        description:
            'Repositories read as context: JSON array of {"repository","instructions"?,"ref"?}.',
    },
];

/** The keys the team-key path (`/cli/config/repositories/:id/settings`) has always taken. */
export const LEGACY_SETTING_ALIASES: Readonly<Record<string, string>> = {
    'review.enabled': 'automatedReviewActive',
    'review.autoApprove': 'pullRequestApprovalActive',
    'review.requestChanges.minSeverity':
        'suggestionControl.severityLevelFilter',
    'patterns.ignoreFiles': 'ignorePaths',
    'patterns.baseBranches': 'baseBranches',
    'patterns.ignoreTitles': 'ignoredTitleKeywords',
};

const SETTINGS_BY_KEY = new Map(
    REVIEW_SETTINGS.map((setting) => [setting.key, setting]),
);

export function resolveReviewSetting(key: string): ReviewSettingDefinition {
    const canonical = LEGACY_SETTING_ALIASES[key] ?? key;
    const setting = SETTINGS_BY_KEY.get(canonical);
    if (!setting) {
        throw new CommandError(
            'INVALID_INPUT',
            `Unknown setting '${key}'. Run 'kodus config remote keys' to list the settable keys.`,
        );
    }
    return setting;
}

/** The legacy alias for a key, when the team-key path can write it. */
export function legacyAliasFor(key: string): string | undefined {
    if (LEGACY_SETTING_ALIASES[key]) {
        return key;
    }
    return Object.entries(LEGACY_SETTING_ALIASES).find(
        ([, canonical]) => canonical === key,
    )?.[0];
}

function invalid(setting: ReviewSettingDefinition, expected: string): never {
    throw new CommandError(
        'INVALID_INPUT',
        `Setting '${setting.key}' expects ${expected}.`,
    );
}

export function parseReviewSettingValue(
    setting: ReviewSettingDefinition,
    raw: string,
): unknown {
    switch (setting.type) {
        case 'boolean':
            if (raw === 'true') {
                return true;
            }
            if (raw === 'false') {
                return false;
            }
            return invalid(setting, "'true' or 'false'");
        case 'number': {
            const value = Number(raw);
            if (raw.trim() === '' || !Number.isFinite(value) || value < 0) {
                return invalid(setting, 'a number of 0 or more');
            }
            return value;
        }
        case 'enum':
            if (!setting.values?.includes(raw)) {
                return invalid(
                    setting,
                    `one of: ${setting.values?.join(', ')}`,
                );
            }
            return raw;
        case 'string':
            if (
                setting.maxLength !== undefined &&
                raw.length > setting.maxLength
            ) {
                return invalid(
                    setting,
                    `at most ${setting.maxLength} characters`,
                );
            }
            return raw;
        case 'string[]': {
            const trimmed = raw.trim();
            if (trimmed.startsWith('[')) {
                let parsed: unknown;
                try {
                    parsed = JSON.parse(trimmed);
                } catch {
                    return invalid(setting, 'a JSON array of strings');
                }
                if (
                    !Array.isArray(parsed) ||
                    parsed.some((item) => typeof item !== 'string')
                ) {
                    return invalid(setting, 'a JSON array of strings');
                }
                return parsed;
            }
            return parseRepositoryPatternList(raw);
        }
        case 'json': {
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                return invalid(setting, 'valid JSON');
            }
            if (
                !Array.isArray(parsed) ||
                parsed.some(
                    (item) =>
                        !item ||
                        typeof item !== 'object' ||
                        typeof (item as { repository?: unknown }).repository !==
                            'string',
                )
            ) {
                return invalid(
                    setting,
                    'a JSON array of objects with a "repository" string',
                );
            }
            return parsed;
        }
    }
}

/** `a.b.c` + value → `{ a: { b: { c: value } } }`, the partial config a save takes. */
export function buildConfigDelta(
    key: string,
    value: unknown,
): Record<string, unknown> {
    const segments = key.split('.');
    const root: Record<string, unknown> = {};
    let cursor = root;
    segments.forEach((segment, index) => {
        if (index === segments.length - 1) {
            cursor[segment] = value;
            return;
        }
        const next: Record<string, unknown> = {};
        cursor[segment] = next;
        cursor = next;
    });
    return root;
}
