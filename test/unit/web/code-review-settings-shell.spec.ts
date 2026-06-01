import {
    buildCodeReviewSettingsScopeKey,
    buildCodeReviewSettingsHydrationKey,
    mergeFormattedCodeReviewConfigForScope,
    shouldHydrateCodeReviewForm,
    shouldResetCodeReviewFormForScopeChange,
} from '../../../apps/web/src/app/(app)/settings/code-review/_utils/settings-shell';

describe('code review settings shell helpers', () => {
    const createFormattedValue = (value: unknown, level = 'global') => ({
        value,
        level,
    });

    const createBaseConfig = () =>
        ({
            id: 'global',
            name: 'Global',
            isSelected: true,
            configs: {
                automatedReviewActive: createFormattedValue(true),
                showStatusFeedback: createFormattedValue(true),
                reviewCadence: {
                    type: createFormattedValue('automatic'),
                },
                ignorePaths: createFormattedValue(['yarn.lock']),
                baseBranches: createFormattedValue(['main']),
                reviewOptions: {
                    bug: createFormattedValue(true),
                },
                ignoredTitleKeywords: createFormattedValue([]),
                summary: {
                    generatePRSummary: createFormattedValue(true),
                    behaviourForExistingDescription:
                        createFormattedValue('replace'),
                    customInstructions: createFormattedValue(''),
                    behaviourForNewCommits: createFormattedValue('none'),
                },
                suggestionControl: {
                    groupingMode: createFormattedValue('minimal'),
                    limitationType: createFormattedValue('pr'),
                    maxSuggestions: createFormattedValue(5),
                    severityLevelFilter: createFormattedValue('low'),
                    applyFiltersToKodyRules: createFormattedValue(false),
                },
                pullRequestApprovalActive: createFormattedValue(false),
                kodusConfigFileOverridesWebPreferences:
                    createFormattedValue(false),
                isRequestChangesActive: createFormattedValue(false),
                runOnDraft: createFormattedValue(true),
                ideRulesSyncEnabled: createFormattedValue(false),
                enableCommittableSuggestions: createFormattedValue(false),
                codeReviewVersion: createFormattedValue('v2'),
                showToggleCodeReviewVersion: true,
            },
            repositories: [
                {
                    id: 'repo-1',
                    name: 'Repo 1',
                    isSelected: true,
                    configs: {
                        showStatusFeedback: createFormattedValue(
                            false,
                            'repository',
                        ),
                    },
                    directories: [
                        {
                            id: 'dir-1',
                            name: 'src',
                            path: '/src',
                            isSelected: true,
                            configs: {
                                showStatusFeedback: createFormattedValue(
                                    true,
                                    'directory',
                                ),
                            },
                        },
                    ],
                },
            ],
        }) as any;

    it('builds a stable scope key from team, repository and directory', () => {
        expect(
            buildCodeReviewSettingsScopeKey('team-1', 'global', undefined),
        ).toBe('team-1::global::root');
        expect(
            buildCodeReviewSettingsScopeKey('team-1', 'repo-1', 'dir-1'),
        ).toBe('team-1::repo-1::dir-1');
    });

    it('resets only when the scope key changes', () => {
        expect(
            shouldResetCodeReviewFormForScopeChange(
                'team-1::global::root',
                'team-1::global::root',
            ),
        ).toBe(false);
        expect(
            shouldResetCodeReviewFormForScopeChange(
                'team-1::global::root',
                'team-1::repo-1::root',
            ),
        ).toBe(true);
    });

    it('builds a hydration key from scope and language', () => {
        expect(
            buildCodeReviewSettingsHydrationKey(
                'team-1::global::root',
                'english',
            ),
        ).toBe('team-1::global::root::english');
    });

    it('hydrates only when the scope-language baseline changes', () => {
        expect(
            shouldHydrateCodeReviewForm(
                'team-1::global::root::english',
                'team-1::global::root::english',
            ),
        ).toBe(false);
        expect(
            shouldHydrateCodeReviewForm(
                'team-1::global::root::english',
                'team-1::repo-1::root::english',
            ),
        ).toBe(true);
        expect(
            shouldHydrateCodeReviewForm(
                'team-1::global::root::english',
                'team-1::global::root::portuguese',
            ),
        ).toBe(true);
    });

    it('merges saved values into the global scope without dropping shell flags', () => {
        const current = createBaseConfig();
        const next = {
            ...current.configs,
            showStatusFeedback: createFormattedValue(false, 'global'),
        };

        const updated = mergeFormattedCodeReviewConfigForScope(
            current,
            { repositoryId: 'global' },
            next,
        );

        expect(updated?.configs.showStatusFeedback.value).toBe(false);
        expect(updated?.configs.showToggleCodeReviewVersion).toBe(true);
        expect(updated?.repositories[0].configs.showStatusFeedback.value).toBe(
            false,
        );
    });

    it('merges saved values into repository and directory scopes without mutating siblings', () => {
        const current = createBaseConfig();

        const repositoryUpdate = mergeFormattedCodeReviewConfigForScope(
            current,
            { repositoryId: 'repo-1' },
            {
                showStatusFeedback: createFormattedValue(true, 'repository'),
            } as any,
        );

        expect(
            repositoryUpdate?.repositories[0].configs.showStatusFeedback.value,
        ).toBe(true);
        expect(
            repositoryUpdate?.repositories[0].directories[0].configs
                .showStatusFeedback.value,
        ).toBe(true);

        const directoryUpdate = mergeFormattedCodeReviewConfigForScope(
            current,
            { repositoryId: 'repo-1', directoryId: 'dir-1' },
            {
                showStatusFeedback: createFormattedValue(false, 'directory'),
            } as any,
        );

        expect(
            directoryUpdate?.repositories[0].directories[0].configs
                .showStatusFeedback.value,
        ).toBe(false);
        expect(
            directoryUpdate?.repositories[0].configs.showStatusFeedback.value,
        ).toBe(false);
    });
});
