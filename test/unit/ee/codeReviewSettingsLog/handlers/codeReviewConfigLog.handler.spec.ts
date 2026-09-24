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
    kodyKnowledgeApproval: { enabled: false },
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

        it('detects kodyKnowledgeApproval toggle', async () => {
            await callHandler(
                { kodyKnowledgeApproval: { enabled: false } },
                { kodyKnowledgeApproval: { enabled: true } },
            );

            const data = extractChangedData(mockUnified.saveLogEntry);
            expect(data).toHaveLength(1);
            expect(data[0].description).toContain('Kody Knowledge Approval');
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

// ─────────────────────────────────────────────────────────────
// Mutation-killing unit tests for the deterministic helpers.
// These call the private/pure methods directly for exact-value,
// boundary, and branch coverage that the integration tests above
// cannot pin precisely.
// ─────────────────────────────────────────────────────────────

describe('CodeReviewConfigLogHandler — deterministic units', () => {
    let handler: CodeReviewConfigLogHandler;
    // None of the methods under test touch the injected dependency.
    const h = () => handler as any;

    beforeEach(() => {
        handler = new CodeReviewConfigLogHandler({} as any);
    });

    // ─── generateCreationEntry ───

    describe('generateCreationEntry', () => {
        it('builds the DIRECTORY entry using directory.path and repository.name', () => {
            const result = h().generateCreationEntry({
                userInfo: { userEmail: 'author@test.com' },
                configLevel: ConfigLevel.DIRECTORY,
                directory: { id: 'dir-1', path: '/src/app' },
                repository: { id: 'repo-1', name: 'my-repo' },
            });

            expect(result).toEqual({
                actionDescription: 'Directory Configuration Created',
                previousValue: null,
                currentValue: {
                    directoryId: 'dir-1',
                    directoryPath: '/src/app',
                    repositoryId: 'repo-1',
                },
                description:
                    'User author@test.com created configuration for directory "/src/app" in repository "my-repo"',
            });
        });

        it('falls back to directory.id and repository.id when path/name are missing', () => {
            const result = h().generateCreationEntry({
                userInfo: { userEmail: 'author@test.com' },
                configLevel: ConfigLevel.DIRECTORY,
                directory: { id: 'dir-1', path: undefined },
                repository: { id: 'repo-1' },
            });

            expect(result.description).toBe(
                'User author@test.com created configuration for directory "dir-1" in repository "repo-1"',
            );
            expect(result.currentValue.directoryPath).toBeUndefined();
        });

        it('uses the REPOSITORY branch when configLevel is DIRECTORY but directory is absent', () => {
            const result = h().generateCreationEntry({
                userInfo: { userEmail: 'author@test.com' },
                configLevel: ConfigLevel.DIRECTORY,
                directory: undefined,
                repository: { id: 'repo-1', name: 'my-repo' },
            });

            expect(result).toEqual({
                actionDescription: 'Repository Configuration Created',
                previousValue: null,
                currentValue: {
                    repositoryId: 'repo-1',
                    repositoryName: 'my-repo',
                },
                description:
                    'User author@test.com created configuration for repository "my-repo"',
            });
        });

        it('builds the REPOSITORY entry and falls back to repository.id for the label', () => {
            const result = h().generateCreationEntry({
                userInfo: { userEmail: 'author@test.com' },
                configLevel: ConfigLevel.REPOSITORY,
                repository: { id: 'repo-1' },
            });

            expect(result.actionDescription).toBe(
                'Repository Configuration Created',
            );
            expect(result.currentValue).toEqual({
                repositoryId: 'repo-1',
                repositoryName: 'repo-1',
            });
            expect(result.description).toBe(
                'User author@test.com created configuration for repository "repo-1"',
            );
        });
    });

    // ─── resolveWithDefaults ───

    describe('resolveWithDefaults', () => {
        it('returns the defaults unchanged when the delta is null', () => {
            const result = h().resolveWithDefaults(null);
            expect(result.pullRequestApprovalActive).toBe(false);
            expect(result.suggestionControl.maxSuggestions).toBe(15);
            expect(result.summary.behaviourForExistingDescription).toBe(
                'concatenate',
            );
        });

        it('overlays the delta on top of the defaults (nested merge preserved)', () => {
            const result = h().resolveWithDefaults({
                pullRequestApprovalActive: true,
                suggestionControl: { maxSuggestions: 42 },
            });

            expect(result.pullRequestApprovalActive).toBe(true);
            // overridden nested key
            expect(result.suggestionControl.maxSuggestions).toBe(42);
            // sibling nested key survives from defaults
            expect(result.suggestionControl.groupingMode).toBe('file');
        });
    });

    // ─── deepMerge ───

    describe('deepMerge', () => {
        it('shallow-merges top-level keys, source wins on collision', () => {
            expect(h().deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({
                a: 1,
                b: 3,
                c: 4,
            });
        });

        it('recursively merges nested plain objects', () => {
            expect(
                h().deepMerge({ x: { a: 1, b: 2 } }, { x: { b: 9, d: 4 } }),
            ).toEqual({ x: { a: 1, b: 9, d: 4 } });
        });

        it('replaces arrays wholesale rather than merging them', () => {
            expect(h().deepMerge({ arr: [1, 2, 3] }, { arr: [9] })).toEqual({
                arr: [9],
            });
        });

        it('replaces a target object with a null source value', () => {
            expect(h().deepMerge({ a: { x: 1 } }, { a: null })).toEqual({
                a: null,
            });
        });

        it('replaces a target primitive with a source object', () => {
            expect(h().deepMerge({ a: 1 }, { a: { x: 2 } })).toEqual({
                a: { x: 2 },
            });
        });

        it('does not mutate the target argument', () => {
            const target = { x: { a: 1 } };
            h().deepMerge(target, { x: { b: 2 } });
            expect(target).toEqual({ x: { a: 1 } });
        });
    });

    // ─── flattenObject ───

    describe('flattenObject', () => {
        it('flattens nested plain objects with dot-joined keys', () => {
            expect(
                h().flattenObject({ a: 1, b: { c: 2, d: { e: 3 } } }),
            ).toEqual({ 'a': 1, 'b.c': 2, 'b.d.e': 3 });
        });

        it('keeps arrays as leaf values (does not flatten them)', () => {
            expect(h().flattenObject({ arr: [1, 2], n: 5 })).toEqual({
                arr: [1, 2],
                n: 5,
            });
        });

        it('keeps null as a leaf value', () => {
            expect(h().flattenObject({ x: null, y: { z: null } })).toEqual({
                'x': null,
                'y.z': null,
            });
        });

        it('applies the prefix to top-level keys', () => {
            expect(h().flattenObject({ a: 1 }, 'p')).toEqual({ 'p.a': 1 });
        });
    });

    // ─── formatBehaviour ───

    describe('formatBehaviour', () => {
        it('maps the known behaviours to their labels', () => {
            expect(h().formatBehaviour('concatenate')).toBe('Concatenate');
            expect(h().formatBehaviour('complement')).toBe('Complement');
            expect(h().formatBehaviour('replace')).toBe('Replace');
        });

        it('returns the raw value for an unknown behaviour', () => {
            expect(h().formatBehaviour('weird')).toBe('weird');
        });
    });

    // ─── hasSignificantAutomatedReviewChange ───

    describe('hasSignificantAutomatedReviewChange', () => {
        it('is true when the active flag flips', () => {
            expect(
                h().hasSignificantAutomatedReviewChange(
                    { automatedReviewActive: false },
                    { automatedReviewActive: true },
                ),
            ).toBe(true);
        });

        it('is true when the cadence type changes (active unchanged)', () => {
            expect(
                h().hasSignificantAutomatedReviewChange(
                    {
                        automatedReviewActive: true,
                        reviewCadence: { type: 'every_push' },
                    },
                    {
                        automatedReviewActive: true,
                        reviewCadence: { type: 'auto_pause' },
                    },
                ),
            ).toBe(true);
        });

        it('is false when active and non-auto_pause type are identical', () => {
            expect(
                h().hasSignificantAutomatedReviewChange(
                    {
                        automatedReviewActive: true,
                        reviewCadence: { type: 'every_push' },
                    },
                    {
                        automatedReviewActive: true,
                        reviewCadence: { type: 'every_push' },
                    },
                ),
            ).toBe(false);
        });

        it('is true when both are auto_pause but pushesToTrigger differs', () => {
            expect(
                h().hasSignificantAutomatedReviewChange(
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
                            timeWindow: 30,
                        },
                    },
                ),
            ).toBe(true);
        });

        it('is true when both are auto_pause but timeWindow differs', () => {
            expect(
                h().hasSignificantAutomatedReviewChange(
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
                            pushesToTrigger: 3,
                            timeWindow: 60,
                        },
                    },
                ),
            ).toBe(true); // timeWindow differs → true
        });

        it('is false when both are auto_pause with identical parameters', () => {
            expect(
                h().hasSignificantAutomatedReviewChange(
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
                            pushesToTrigger: 3,
                            timeWindow: 30,
                        },
                    },
                ),
            ).toBe(false);
        });
    });

    // ─── hasSignificantSummaryChange ───

    describe('hasSignificantSummaryChange', () => {
        it('is true when generatePRSummary flips', () => {
            expect(
                h().hasSignificantSummaryChange(
                    { summary: { generatePRSummary: false } },
                    { summary: { generatePRSummary: true } },
                ),
            ).toBe(true);
        });

        it('is true when only the behaviour changes (generate unchanged)', () => {
            expect(
                h().hasSignificantSummaryChange(
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
                ),
            ).toBe(true);
        });

        it('is false when generate and behaviour are identical', () => {
            expect(
                h().hasSignificantSummaryChange(
                    {
                        summary: {
                            generatePRSummary: true,
                            behaviourForExistingDescription: 'concatenate',
                        },
                    },
                    {
                        summary: {
                            generatePRSummary: true,
                            behaviourForExistingDescription: 'concatenate',
                        },
                    },
                ),
            ).toBe(false);
        });

        it('is false when summary is absent on both sides', () => {
            expect(h().hasSignificantSummaryChange({}, {})).toBe(false);
        });
    });

    // ─── collectBasicChanges ───

    describe('collectBasicChanges', () => {
        it('emits an exact BasicChange for a tracked top-level property', () => {
            const changes = h().collectBasicChanges(
                { pullRequestApprovalActive: false },
                { pullRequestApprovalActive: true },
            );

            expect(changes).toEqual([
                {
                    key: 'pullRequestApprovalActive',
                    oldValue: false,
                    newValue: true,
                    displayName: 'Pull Request Approval',
                    path: ['pullRequestApprovalActive'],
                },
            ]);
        });

        it('splits nested keys into a path array', () => {
            const changes = h().collectBasicChanges(
                { reviewOptions: { bug: true } },
                { reviewOptions: { bug: false } },
            );

            expect(changes).toEqual([
                {
                    key: 'reviewOptions.bug',
                    oldValue: true,
                    newValue: false,
                    displayName: 'Bug Detection',
                    path: ['reviewOptions', 'bug'],
                },
            ]);
        });

        it('skips keys listed in excludeKeys', () => {
            const changes = h().collectBasicChanges(
                { pullRequestApprovalActive: false },
                { pullRequestApprovalActive: true },
                ['pullRequestApprovalActive'],
            );

            expect(changes).toEqual([]);
        });

        it('ignores properties that are not in PROPERTY_CONFIGS', () => {
            const changes = h().collectBasicChanges(
                { someUnknownProp: 'a' },
                { someUnknownProp: 'b' },
            );

            expect(changes).toEqual([]);
        });

        it('emits nothing when nothing changed', () => {
            const changes = h().collectBasicChanges(
                { pullRequestApprovalActive: true },
                { pullRequestApprovalActive: true },
            );

            expect(changes).toEqual([]);
        });
    });

    // ─── collectSpecialChanges ───

    describe('collectSpecialChanges', () => {
        it('emits an automatedReviewActive special change with exact metadata', () => {
            const changes = h().collectSpecialChanges(
                { automatedReviewActive: false },
                { automatedReviewActive: true },
            );

            expect(changes).toEqual([
                {
                    displayName: 'Automated Code Review',
                    customDescription: 'Automated Code Review: enabled',
                    isSpecial: true,
                    key: 'automatedReviewActive',
                },
            ]);
        });

        it('emits a summary special change with exact metadata', () => {
            const changes = h().collectSpecialChanges(
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

            expect(changes).toEqual([
                {
                    displayName: 'Generate PR Summary',
                    customDescription:
                        'Generate PR Summary: enabled with Replace behavior',
                    isSpecial: true,
                    key: 'summary.generatePRSummary',
                },
            ]);
        });

        it('emits both special changes in [automated, summary] order', () => {
            const changes = h().collectSpecialChanges(
                {
                    automatedReviewActive: false,
                    summary: { generatePRSummary: false },
                },
                {
                    automatedReviewActive: true,
                    summary: { generatePRSummary: true },
                },
            );

            expect(changes).toHaveLength(2);
            expect(changes[0].key).toBe('automatedReviewActive');
            expect(changes[1].key).toBe('summary.generatePRSummary');
        });

        it('emits an empty array when neither special case applies', () => {
            const changes = h().collectSpecialChanges(
                { automatedReviewActive: true },
                { automatedReviewActive: true },
            );

            expect(changes).toEqual([]);
        });
    });

    // ─── buildCompleteNestedStructure ───

    describe('buildCompleteNestedStructure', () => {
        it('rebuilds a nested structure from a basic change path (oldValue)', () => {
            const changes = [
                {
                    key: 'reviewOptions.bug',
                    oldValue: true,
                    newValue: false,
                    displayName: 'Bug Detection',
                    path: ['reviewOptions', 'bug'],
                },
            ];

            expect(
                h().buildCompleteNestedStructure(changes, {}, {}, 'oldValue'),
            ).toEqual({ reviewOptions: { bug: true } });
        });

        it('rebuilds a nested structure using newValue when requested', () => {
            const changes = [
                {
                    key: 'reviewOptions.bug',
                    oldValue: true,
                    newValue: false,
                    displayName: 'Bug Detection',
                    path: ['reviewOptions', 'bug'],
                },
            ];

            expect(
                h().buildCompleteNestedStructure(changes, {}, {}, 'newValue'),
            ).toEqual({ reviewOptions: { bug: false } });
        });

        it('pulls automatedReviewActive + reviewCadence from the source config for special changes', () => {
            const changes = [
                {
                    displayName: 'Automated Code Review',
                    customDescription: 'x',
                    isSpecial: true,
                    key: 'automatedReviewActive',
                },
            ];
            const oldConfig = {
                automatedReviewActive: false,
                reviewCadence: { type: 'every_push' },
            };
            const newConfig = {
                automatedReviewActive: true,
                reviewCadence: { type: 'auto_pause', pushesToTrigger: 3 },
            };

            expect(
                h().buildCompleteNestedStructure(
                    changes,
                    oldConfig,
                    newConfig,
                    'oldValue',
                ),
            ).toEqual({
                automatedReviewActive: false,
                reviewCadence: { type: 'every_push' },
            });

            expect(
                h().buildCompleteNestedStructure(
                    changes,
                    oldConfig,
                    newConfig,
                    'newValue',
                ),
            ).toEqual({
                automatedReviewActive: true,
                reviewCadence: { type: 'auto_pause', pushesToTrigger: 3 },
            });
        });

        it('pulls summary fields from the source config for the summary special change', () => {
            const changes = [
                {
                    displayName: 'Generate PR Summary',
                    customDescription: 'x',
                    isSpecial: true,
                    key: 'summary.generatePRSummary',
                },
            ];
            const newConfig = {
                summary: {
                    generatePRSummary: true,
                    behaviourForExistingDescription: 'replace',
                },
            };

            expect(
                h().buildCompleteNestedStructure(
                    changes,
                    {},
                    newConfig,
                    'newValue',
                ),
            ).toEqual({
                summary: {
                    generatePRSummary: true,
                    behaviourForExistingDescription: 'replace',
                },
            });
        });

        it('merges basic and special changes into one structure', () => {
            const changes = [
                {
                    key: 'pullRequestApprovalActive',
                    oldValue: false,
                    newValue: true,
                    displayName: 'Pull Request Approval',
                    path: ['pullRequestApprovalActive'],
                },
                {
                    displayName: 'Automated Code Review',
                    customDescription: 'x',
                    isSpecial: true,
                    key: 'automatedReviewActive',
                },
            ];
            const newConfig = {
                automatedReviewActive: true,
                reviewCadence: { type: 'every_push' },
            };

            expect(
                h().buildCompleteNestedStructure(
                    changes,
                    {},
                    newConfig,
                    'newValue',
                ),
            ).toEqual({
                pullRequestApprovalActive: true,
                automatedReviewActive: true,
                reviewCadence: { type: 'every_push' },
            });
        });
    });

    // ─── createUnifiedChangedData ───

    describe('createUnifiedChangedData', () => {
        it('assembles the full ChangedDataToExport for a single basic change', () => {
            const changes = [
                {
                    key: 'pullRequestApprovalActive',
                    oldValue: false,
                    newValue: true,
                    displayName: 'Pull Request Approval',
                    path: ['pullRequestApprovalActive'],
                },
            ];

            const result = h().createUnifiedChangedData(
                changes,
                { userEmail: 'author@test.com' },
                {},
                {},
            );

            expect(result).toEqual({
                actionDescription: 'Configuration Updated',
                previousValue: { pullRequestApprovalActive: false },
                currentValue: { pullRequestApprovalActive: true },
                description:
                    'User author@test.com changed Pull Request Approval from disabled to enabled',
            });
        });
    });
});
