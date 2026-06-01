import { checkbox, input, select } from '@inquirer/prompts';
import type { RepositorySettings } from '../types/repo-config.js';
import { formatRepositorySetupSection } from '../formatters/repo-config.js';
import { parseRepositoryPatternList } from '../utils/repo-settings-schema.js';

type CollectSettingsOptions = {
    yes?: boolean;
    writeLine?: (line: string) => void;
};

type SettingsSection = 'all' | 'general' | 'patterns';

const RECOMMENDED_IGNORED_FILE_PATTERNS = [
    'yarn.lock',
    'package-lock.json',
    'package.json',
    '.env',
    '**/*.json',
] as const;

const COMMON_IGNORED_FILE_PATTERNS = [
    ...RECOMMENDED_IGNORED_FILE_PATTERNS,
    'dist/**',
    'coverage/**',
    '**/generated/**',
] as const;

const COMMON_BASE_BRANCH_PATTERNS = [
    'main',
    'develop',
    'release/*',
    'hotfix/*',
] as const;

const COMMON_IGNORED_TITLE_PATTERNS = [
    'wip*',
    'draft*',
    'chore(release)*',
    'release:*',
] as const;

function summarizePatterns(patterns: string[]): string {
    return patterns.length > 0 ? patterns.join(', ') : '(none)';
}

function summarizePatternOption(
    patterns: readonly string[],
    maxItems = 3,
): string {
    if (patterns.length === 0) {
        return '(none)';
    }

    const visible = patterns.slice(0, maxItems);
    const remaining = patterns.length - visible.length;
    if (remaining <= 0) {
        return visible.join(', ');
    }

    return `${visible.join(', ')} +${remaining} more`;
}

class RepositorySettingsWizardService {
    async collectSettings(
        current: RepositorySettings,
        options: CollectSettingsOptions = {},
        section: SettingsSection = 'all',
    ): Promise<RepositorySettings> {
        if (options.yes) {
            return current;
        }

        if (section === 'general') {
            return this.collectGeneralSettings(current, options);
        }

        if (section === 'patterns') {
            return this.collectPatternSettings(current, options);
        }

        const withGeneral = await this.collectGeneralSettings(current, options);
        return this.collectPatternSettings(withGeneral, options);
    }

    async collectGeneralSettings(
        current: RepositorySettings,
        options: CollectSettingsOptions = {},
    ): Promise<RepositorySettings> {
        const writeLine = options.writeLine ?? (() => {});
        for (const line of formatRepositorySetupSection(
            'General',
            'Choose the review behaviors you want for this repository.',
        )) {
            writeLine(line);
        }

        writeLine(
            'Kody automatically reviews pull requests when they are opened or updated.',
        );
        writeLine(
            'When disabled, you can still trigger a review manually with @kody start-review.',
        );
        const reviewEnabled = await select<boolean>({
            message: 'Automated code review',
            default: current.reviewEnabled,
            choices: [
                { name: 'Enabled', value: true },
                { name: 'Disabled', value: false },
            ],
        });

        writeLine(
            'Automatically approves the pull request when the review finishes without issues.',
        );
        const autoApproveEnabled = await select<boolean>({
            message: 'Pull request approval',
            default: current.autoApproveEnabled,
            choices: [
                { name: 'Enabled', value: true },
                { name: 'Disabled', value: false },
            ],
        });

        writeLine('Only suggestions at or above this severity will be posted.');
        const requestChangesMinSeverity = await select({
            message: 'Minimum severity level',
            default: current.requestChangesMinSeverity,
            choices: [
                { name: 'Low', value: 'low' },
                { name: 'Medium', value: 'medium' },
                { name: 'High', value: 'high' },
                { name: 'Critical', value: 'critical' },
            ],
        });

        return {
            ...current,
            reviewEnabled,
            autoApproveEnabled,
            requestChangesMinSeverity:
                requestChangesMinSeverity as RepositorySettings['requestChangesMinSeverity'],
        };
    }

    async collectPatternSettings(
        current: RepositorySettings,
        options: CollectSettingsOptions = {},
    ): Promise<RepositorySettings> {
        const writeLine = options.writeLine ?? (() => {});

        for (const line of formatRepositorySetupSection(
            'Patterns',
            'Files and titles can use glob patterns. Branches accept branch names or expressions like release/*.',
        )) {
            writeLine(line);
        }

        writeLine('Files matching these glob patterns will be skipped during review.');
        writeLine(
            `Current ignored files: ${summarizePatterns(current.ignoredFilePatterns)}`,
        );
        writeLine('Examples: yarn.lock, package-lock.json, .env, **/*.json');
        const ignoredFilePatterns = await this.collectIgnoredFilePatterns(
            current.ignoredFilePatterns,
        );

        writeLine('Additional base branches that Kody should review against.');
        writeLine(
            `Current base branches: ${summarizePatterns(current.baseBranchPatterns)}`,
        );
        writeLine('Examples: main, develop, release/*');
        const baseBranchPatterns = await this.collectPatternList({
            fieldLabel: 'Base branches',
            customMessage: 'Base branches (comma-separated or one per line)',
            current: current.baseBranchPatterns,
            commonPatterns: COMMON_BASE_BRANCH_PATTERNS,
        });

        writeLine(
            'Kody skips the review when the pull request title matches one of these patterns.',
        );
        writeLine(
            `Current ignored title patterns: ${summarizePatterns(current.ignoredTitlePatterns)}`,
        );
        writeLine('Case-insensitive. Examples: wip*, draft*, chore(release)*');
        const ignoredTitlePatterns = await this.collectPatternList({
            fieldLabel: 'Ignored title patterns',
            customMessage:
                'Ignored title patterns (comma-separated or one per line)',
            current: current.ignoredTitlePatterns,
            commonPatterns: COMMON_IGNORED_TITLE_PATTERNS,
        });

        return {
            ...current,
            ignoredFilePatterns,
            baseBranchPatterns,
            ignoredTitlePatterns,
        };
    }

    private async collectIgnoredFilePatterns(current: string[]): Promise<string[]> {
        while (true) {
            const mode = await this.selectPatternMode(
                'Ignored files',
                current,
                COMMON_IGNORED_FILE_PATTERNS.length,
                true,
            );

            switch (mode) {
                case 'recommended':
                    return [...RECOMMENDED_IGNORED_FILE_PATTERNS];
                case 'common': {
                    const selected = await checkbox<string>({
                        message: 'Choose the file patterns to ignore',
                        choices: COMMON_IGNORED_FILE_PATTERNS.map((pattern) => ({
                            name: pattern,
                            value: pattern,
                            checked: current.includes(pattern),
                        })),
                    });

                    if (await this.shouldUseSelectedPatterns()) {
                        return selected;
                    }

                    continue;
                }
                case 'custom':
                    {
                        const customPatterns = parseRepositoryPatternList(
                            await input({
                                message:
                                    'Ignored file patterns (comma-separated or one per line)',
                                default: current.join('\n'),
                            }),
                        );

                        if (await this.confirmPatternDraft(customPatterns)) {
                            return customPatterns;
                        }
                    }

                    continue;
                case 'clear':
                    return [];
                case 'keep-current':
                default:
                    return current;
            }
        }
    }

    private async collectPatternList(options: {
        fieldLabel: string;
        customMessage: string;
        current: string[];
        commonPatterns: readonly string[];
    }): Promise<string[]> {
        while (true) {
            const mode = await this.selectPatternMode(
                options.fieldLabel,
                options.current,
                options.commonPatterns.length,
            );

            switch (mode) {
                case 'common': {
                    const selected = await checkbox<string>({
                        message: `Choose ${options.fieldLabel.toLowerCase()}`,
                        choices: options.commonPatterns.map((pattern) => ({
                            name: pattern,
                            value: pattern,
                            checked: options.current.includes(pattern),
                        })),
                    });

                    if (await this.shouldUseSelectedPatterns()) {
                        return selected;
                    }

                    continue;
                }
                case 'custom':
                    {
                        const customPatterns = parseRepositoryPatternList(
                            await input({
                                message: options.customMessage,
                                default: options.current.join('\n'),
                            }),
                        );

                        if (await this.confirmPatternDraft(customPatterns)) {
                            return customPatterns;
                        }
                    }

                    continue;
                case 'clear':
                    return [];
                case 'keep-current':
                default:
                    return options.current;
            }
        }
    }

    private async shouldUseSelectedPatterns(): Promise<boolean> {
        const nextAction = await select<string>({
            message: 'What do you want to do with this selection?',
            default: 'apply',
            choices: [
                { name: 'Use selected patterns', value: 'apply' },
                { name: 'Back to pattern options', value: 'back' },
            ],
        });

        return nextAction === 'apply';
    }

    private async confirmPatternDraft(patterns: string[]): Promise<boolean> {
        const nextAction = await select<string>({
            message: 'What do you want to do with these patterns?',
            default: 'apply',
            choices: [
                {
                    name: `Use these patterns (${summarizePatterns(patterns)})`,
                    value: 'apply',
                },
                { name: 'Back to pattern options', value: 'back' },
            ],
        });

        return nextAction === 'apply';
    }

    private async selectPatternMode(
        fieldLabel: string,
        current: string[],
        commonPatternCount: number,
        includeRecommended = false,
    ): Promise<string> {
        const choices = [
            {
                name: `Keep current value (${summarizePatterns(current)})`,
                value: 'keep-current',
            },
        ];
        if (includeRecommended) {
            choices.push({
                name: `Use recommended defaults (${summarizePatternOption(RECOMMENDED_IGNORED_FILE_PATTERNS)})`,
                value: 'recommended',
            });
        }
        choices.push(
            {
                name: `Choose common patterns (${commonPatternCount} available)`,
                value: 'common',
            },
            { name: 'Enter custom patterns', value: 'custom' },
            { name: 'Clear patterns ((none))', value: 'clear' },
        );

        return await select<string>({
            message: fieldLabel,
            default: 'keep-current',
            choices,
        });
    }
}

export { RepositorySettingsWizardService };
export const repositorySettingsWizardService =
    new RepositorySettingsWizardService();
