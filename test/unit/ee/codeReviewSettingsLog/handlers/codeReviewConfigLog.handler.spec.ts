import { CodeReviewConfigLogHandler } from '@libs/ee/codeReviewSettingsLog/infrastructure/adapters/services/codeReviewConfigLog.handler';
import {
    ActionType,
    ConfigLevel,
} from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import {
    createMockUnifiedLogHandler,
    createBaseParams,
    extractChangedData,
} from './helpers/shared-mocks';

const MOCK_DEFAULTS = {
    pullRequestApprovalActive: false,
    isRequestChangesActive: false,
    runOnDraft: false,
    languageResultPrompt: 'English',
    isCommitMode: false,
    reviewOptions: {
        bug: true,
        performance: true,
        security: true,
        cross_file: false,
        business_logic: false,
    },
    suggestionControl: {
        groupingMode: 'file',
        limitationType: 'by_file',
        maxSuggestions: 15,
        severityLevelFilter: 'all',
        applyFiltersToKodyRules: false,
    },
    summary: {
        generatePRSummary: false,
        behaviourForExistingDescription: 'concatenate',
        customInstructions: '',
    },
    ignorePaths: [],
    ignoredTitleKeywords: [],
    baseBranches: [],
    kodyRulesGeneratorEnabled: false,
    llmGeneratedMemoriesRequireApproval: false,
    enableCommittableSuggestions: false,
    automatedReviewActive: false,
    reviewCadence: { type: 'every_push' },
    kodusConfigFileOverridesWebPreferences: false,
    showStatusFeedback: false,
    crossFileDependenciesAnalysis: false,
};

jest.mock('@libs/common/utils/validateCodeReviewConfigFile', () => ({
    getDefaultKodusConfigFile: () => ({ ...MOCK_DEFAULTS }),
}));

describe('CodeReviewConfigLogHandler', () => {
    let handler: CodeReviewConfigLogHandler;
    let mockUnified: ReturnType<typeof createMockUnifiedLogHandler>;

    beforeEach(() => {
        mockUnified = createMockUnifiedLogHandler();
        handler = new CodeReviewConfigLogHandler(mockUnified as any);
    });

    const callHandler = (oldConfig: any, newConfig: any, overrides: any = {}) =>
        handler.logCodeReviewConfig({
            ...createBaseParams(),
            oldConfig,
            newConfig,
            ...overrides,
        });

    // ─── General settings (GLOBAL level) ───

    describe('general settings', () => {
        it('detects pullRequestApprovalActive toggle false→true', async () => {
            await callHandler(
                { pullRequestApprovalActive: false },
                { pullRequestApprovalActive: true },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].actionDescription).toBe('Configuration Updated');
            expect(data[0].description).toContain('Pull Request Approval');
            expect(data[0].description).toContain('disabled');
            expect(data[0].description).toContain('enabled');
        });

        it('detects isRequestChangesActive toggle', async () => {
            await callHandler(
                { isRequestChangesActive: false },
                { isRequestChangesActive: true },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Request Changes');
        });

        it('detects runOnDraft toggle', async () => {
            await callHandler({ runOnDraft: false }, { runOnDraft: true });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Run on Draft');
        });

        it('detects languageResultPrompt string change', async () => {
            await callHandler(
                { languageResultPrompt: 'English' },
                { languageResultPrompt: 'Portuguese' },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Language Result Prompt');
            expect(data[0].description).toContain('English');
            expect(data[0].description).toContain('Portuguese');
        });

        it('detects isCommitMode toggle', async () => {
            await callHandler({ isCommitMode: false }, { isCommitMode: true });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Commit Mode');
        });
    });

    // ─── Review categories ───

    describe('review categories', () => {
        it('detects single category toggle', async () => {
            await callHandler(
                { reviewOptions: { bug: true } },
                { reviewOptions: { bug: false } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Bug Detection');
            expect(data[0].description).toContain('enabled');
            expect(data[0].description).toContain('disabled');
        });

        it('detects multiple categories changed simultaneously', async () => {
            await callHandler(
                { reviewOptions: { bug: true, performance: true } },
                { reviewOptions: { bug: false, performance: false } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Bug Detection');
            expect(data[0].description).toContain('Performance');
        });
    });

    // ─── Suggestion control ───

    describe('suggestion control', () => {
        it('detects groupingMode change', async () => {
            await callHandler(
                { suggestionControl: { groupingMode: 'file' } },
                { suggestionControl: { groupingMode: 'full' } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Grouping Mode');
        });

        it('detects limitationType change', async () => {
            await callHandler(
                { suggestionControl: { limitationType: 'by_file' } },
                { suggestionControl: { limitationType: 'by_pr' } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Limitation Type');
        });

        it('detects maxSuggestions numeric change', async () => {
            await callHandler(
                { suggestionControl: { maxSuggestions: 15 } },
                { suggestionControl: { maxSuggestions: 25 } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Max Suggestions');
            expect(data[0].description).toContain('15');
            expect(data[0].description).toContain('25');
        });

        it('detects severityLevelFilter change', async () => {
            await callHandler(
                { suggestionControl: { severityLevelFilter: 'all' } },
                { suggestionControl: { severityLevelFilter: 'critical' } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Severity Level Filter');
        });

        it('detects applyFiltersToKodyRules toggle', async () => {
            await callHandler(
                { suggestionControl: { applyFiltersToKodyRules: false } },
                { suggestionControl: { applyFiltersToKodyRules: true } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain(
                'Apply Filters to Kody Rules',
            );
        });
    });

    // ─── Business rules ───

    describe('business rules', () => {
        it('detects kodyRulesGeneratorEnabled toggle', async () => {
            await callHandler(
                { kodyRulesGeneratorEnabled: false },
                { kodyRulesGeneratorEnabled: true },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Kody Rules Generator');
        });

        it('detects llmGeneratedMemoriesRequireApproval toggle', async () => {
            await callHandler(
                { llmGeneratedMemoriesRequireApproval: false },
                { llmGeneratedMemoriesRequireApproval: true },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain(
                'LLM Generated Memories Require Approval',
            );
        });

        it('detects enableCommittableSuggestions toggle', async () => {
            await callHandler(
                { enableCommittableSuggestions: false },
                { enableCommittableSuggestions: true },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Committable Suggestions');
        });
    });

    // ─── Array properties ───

    describe('array properties', () => {
        it('detects ignorePaths change', async () => {
            await callHandler(
                { ignorePaths: ['src/old'] },
                { ignorePaths: ['src/old', 'src/new'] },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Ignored Paths');
        });

        it('detects baseBranches change', async () => {
            await callHandler(
                { baseBranches: ['main'] },
                { baseBranches: ['main', 'develop'] },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Base Branches');
        });

        it('detects empty array → populated array', async () => {
            await callHandler(
                { ignorePaths: [] },
                { ignorePaths: ['src/vendor'] },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Ignored Paths');
            expect(data[0].description).toContain('none');
            expect(data[0].description).toContain('src/vendor');
        });
    });

    // ─── Special case: Summary ───

    describe('summary special case', () => {
        it('detects generatePRSummary enabled with behavior', async () => {
            await callHandler(
                {
                    summary: {
                        generatePRSummary: false,
                        behaviourForExistingDescription: 'concatenate',
                    },
                },
                {
                    summary: {
                        generatePRSummary: true,
                        behaviourForExistingDescription: 'replace',
                    },
                },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain(
                'Generate PR Summary: enabled with Replace behavior',
            );
        });

        it('detects generatePRSummary disabled', async () => {
            await callHandler(
                {
                    summary: {
                        generatePRSummary: true,
                        behaviourForExistingDescription: 'concatenate',
                    },
                },
                {
                    summary: {
                        generatePRSummary: false,
                        behaviourForExistingDescription: 'concatenate',
                    },
                },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain(
                'Generate PR Summary: disabled',
            );
        });

        it('detects behavior-only change while summary stays enabled', async () => {
            await callHandler(
                {
                    summary: {
                        generatePRSummary: true,
                        behaviourForExistingDescription: 'concatenate',
                    },
                },
                {
                    summary: {
                        generatePRSummary: true,
                        behaviourForExistingDescription: 'replace',
                    },
                },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain(
                'behavior changed from Concatenate to Replace',
            );
        });

        it('detects summary.customInstructions change', async () => {
            await callHandler(
                { summary: { customInstructions: '' } },
                { summary: { customInstructions: 'Focus on security' } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Custom Instructions');
        });
    });

    // ─── Special case: Automated Review ───

    describe('automated review special case', () => {
        it('detects automated review enabled', async () => {
            await callHandler(
                { automatedReviewActive: false },
                {
                    automatedReviewActive: true,
                    reviewCadence: { type: 'every_push' },
                },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain(
                'Automated Code Review: enabled',
            );
        });

        it('detects automated review enabled with auto_pause cadence', async () => {
            await callHandler(
                { automatedReviewActive: false },
                {
                    automatedReviewActive: true,
                    reviewCadence: {
                        type: 'auto_pause',
                        pushesToTrigger: 3,
                        timeWindow: 30,
                    },
                },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('auto_pause');
            expect(data[0].description).toContain('3 pushes');
            expect(data[0].description).toContain('30 minutes');
        });

        it('detects automated review disabled', async () => {
            await callHandler(
                { automatedReviewActive: true },
                { automatedReviewActive: false },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain(
                'Automated Code Review: disabled',
            );
        });

        it('detects cadence type change while active', async () => {
            await callHandler(
                {
                    automatedReviewActive: true,
                    reviewCadence: { type: 'every_push' },
                },
                {
                    automatedReviewActive: true,
                    reviewCadence: {
                        type: 'auto_pause',
                        pushesToTrigger: 5,
                        timeWindow: 60,
                    },
                },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('changed to auto_pause');
        });

        it('detects auto_pause parameter changes', async () => {
            await callHandler(
                {
                    automatedReviewActive: true,
                    reviewCadence: {
                        type: 'auto_pause',
                        pushesToTrigger: 3,
                        timeWindow: 30,
                    },
                },
                {
                    automatedReviewActive: true,
                    reviewCadence: {
                        type: 'auto_pause',
                        pushesToTrigger: 5,
                        timeWindow: 60,
                    },
                },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('updated auto_pause');
            expect(data[0].description).toContain('5 pushes');
            expect(data[0].description).toContain('60 minutes');
        });
    });

    // ─── Edge cases ───

    describe('edge cases', () => {
        it('does not call saveLogEntry when no changes', async () => {
            await callHandler(
                { pullRequestApprovalActive: false },
                { pullRequestApprovalActive: false },
            );

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });

        it('does not call saveLogEntry when only non-tracked property differs', async () => {
            await callHandler(
                { someUnknownProp: 'a' },
                { someUnknownProp: 'b' },
            );

            expect(mockUnified.saveLogEntry).not.toHaveBeenCalled();
        });

        it('fills missing properties from defaults', async () => {
            // oldConfig has no pullRequestApprovalActive — defaults to false
            // newConfig sets it to true
            await callHandler({}, { pullRequestApprovalActive: true });

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Pull Request Approval');
        });
    });

    // ─── REPOSITORY level ───

    describe('REPOSITORY level', () => {
        it('passes configLevel=REPOSITORY and repository info', async () => {
            await callHandler(
                { pullRequestApprovalActive: false },
                { pullRequestApprovalActive: true },
                {
                    configLevel: ConfigLevel.REPOSITORY,
                    repository: { id: 'repo-1', name: 'my-repo' },
                },
            );

            const call = mockUnified.saveLogEntry.mock.calls[0][0];
            expect(call.configLevel).toBe(ConfigLevel.REPOSITORY);
            expect(call.repository).toEqual({ id: 'repo-1', name: 'my-repo' });
        });

        it('prepends creation entry when isCreation=true', async () => {
            await callHandler(
                { pullRequestApprovalActive: false },
                { pullRequestApprovalActive: true },
                {
                    isCreation: true,
                    configLevel: ConfigLevel.REPOSITORY,
                    repository: { id: 'repo-1', name: 'my-repo' },
                },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data.length).toBeGreaterThanOrEqual(2);
            expect(data[0].actionDescription).toBe(
                'Repository Configuration Created',
            );
            expect(data[0].description).toContain('my-repo');
        });

        it('uses ActionType.CREATE when isCreation=true', async () => {
            await callHandler(
                { pullRequestApprovalActive: false },
                { pullRequestApprovalActive: true },
                {
                    isCreation: true,
                    configLevel: ConfigLevel.REPOSITORY,
                    repository: { id: 'repo-1', name: 'my-repo' },
                },
            );

            const call = mockUnified.saveLogEntry.mock.calls[0][0];
            expect(call.actionType).toBe(ActionType.CREATE);
        });
    });

    // ─── DIRECTORY level ───

    describe('DIRECTORY level', () => {
        it('passes configLevel=DIRECTORY and directory info', async () => {
            await callHandler(
                { pullRequestApprovalActive: false },
                { pullRequestApprovalActive: true },
                {
                    configLevel: ConfigLevel.DIRECTORY,
                    repository: { id: 'repo-1', name: 'my-repo' },
                    directory: { id: 'dir-1', path: '/src' },
                },
            );

            const call = mockUnified.saveLogEntry.mock.calls[0][0];
            expect(call.configLevel).toBe(ConfigLevel.DIRECTORY);
            expect(call.directory).toEqual({ id: 'dir-1', path: '/src' });
        });

        it('prepends directory creation entry when isCreation=true', async () => {
            await callHandler(
                { pullRequestApprovalActive: false },
                { pullRequestApprovalActive: true },
                {
                    isCreation: true,
                    configLevel: ConfigLevel.DIRECTORY,
                    repository: { id: 'repo-1', name: 'my-repo' },
                    directory: { id: 'dir-1', path: '/src' },
                },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data.length).toBeGreaterThanOrEqual(2);
            expect(data[0].actionDescription).toBe(
                'Directory Configuration Created',
            );
            expect(data[0].description).toContain('/src');
            expect(data[0].description).toContain('my-repo');
        });
    });
});
