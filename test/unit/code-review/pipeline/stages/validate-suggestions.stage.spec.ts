import { Test, TestingModule } from '@nestjs/testing';
import { ValidateSuggestionsStage } from '@/code-review/pipeline/stages/validate-suggestions.stage';
import { SandboxSyntaxValidator } from '@/code-review/infrastructure/adapters/services/sandboxSyntaxValidator.service';
import { SuggestionLLMValidator } from '@/code-review/infrastructure/adapters/services/suggestionLLMValidator.service';
import { CodeReviewPipelineContext } from '@/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@/core/domain/enums';

// Mock logger to silence logs during tests
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

// Mock posthog
jest.mock('@libs/common/utils/posthog', () => ({
    __esModule: true,
    default: {
        isFeatureEnabled: jest.fn(),
    },
    FEATURE_FLAGS: {
        committableSuggestions: 'committable-suggestions',
    },
}));

// Mock morphsdk
jest.mock('@morphllm/morphsdk', () => ({
    applyEdit: jest.fn(),
}));

import posthog from '@libs/common/utils/posthog';
import { applyEdit } from '@morphllm/morphsdk';

describe('ValidateSuggestionsStage', () => {
    let stage: ValidateSuggestionsStage;

    const mockSandboxSyntaxValidator = {
        validateFiles: jest.fn().mockResolvedValue(new Set()),
    };

    const mockSuggestionLLMValidator = {
        validateWithLLM: jest.fn().mockResolvedValue({ isValid: true }),
        checkSuggestionSimplicity: jest.fn().mockResolvedValue({ isSimple: true, reason: null }),
    };

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const createBaseContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ) => ({
        dryRun: { enabled: false },
        organizationAndTeamData: mockOrganizationAndTeamData as any,
        repository: {
            id: 'repo-1',
            name: 'test-repo',
            language: 'typescript',
        } as any,
        branch: 'main',
        pullRequest: {
            number: 123,
            title: 'Test PR',
            base: { repo: { fullName: 'org/repo' }, ref: 'main' },
            repository: {} as any,
            isDraft: false,
            stats: {
                total_additions: 10,
                total_deletions: 5,
                total_files: 2,
                total_lines_changed: 15,
            },
        },
        teamAutomationId: 'team-auto-1',
        origin: 'github',
        action: 'opened',
        platformType: PlatformType.GITHUB,
        codeReviewConfig: {
            enableCommittableSuggestions: true,
        } as any,
        validSuggestions: [],
        discardedSuggestions: [],
        changedFiles: [],
        preparedFileContexts: [],
        correlationId: 'test-correlation-id',
        ...overrides,
    });

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ValidateSuggestionsStage,
                {
                    provide: SandboxSyntaxValidator,
                    useValue: mockSandboxSyntaxValidator,
                },
                {
                    provide: SuggestionLLMValidator,
                    useValue: mockSuggestionLLMValidator,
                },
            ],
        }).compile();

        stage = module.get<ValidateSuggestionsStage>(ValidateSuggestionsStage);
        jest.clearAllMocks();
    });

    describe('stage name', () => {
        it('should have correct stage name', () => {
            expect(stage.stageName).toBe('ValidateSuggestionsStage');
        });
    });

    describe('shouldRunStage conditions', () => {
        it('should skip when feature flag is disabled', async () => {
            (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(false);

            const context = createBaseContext({
                validSuggestions: [{ id: 's1', improvedCode: 'const x = 1;' }],
                changedFiles: [
                    { filename: 'test.ts', fileContent: 'var x = 1;' } as any,
                ],
            });

            const result = await (stage as any).executeStage(context);

            // Should return context unchanged when feature is disabled
            expect(result.validSuggestions[0].isCommittable).toBeUndefined();
        });

        it('should skip when enableCommittableSuggestions is false in config', async () => {
            (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);

            const context = createBaseContext({
                codeReviewConfig: {
                    enableCommittableSuggestions: false,
                } as any,
                validSuggestions: [{ id: 's1', improvedCode: 'const x = 1;' }],
                changedFiles: [
                    { filename: 'test.ts', fileContent: 'var x = 1;' } as any,
                ],
            });

            const result = await (stage as any).executeStage(context);

            expect(result.validSuggestions[0].isCommittable).toBeUndefined();
        });

        it('should skip when platform is not GitHub', async () => {
            (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);

            const context = createBaseContext({
                platformType: PlatformType.GITLAB,
                validSuggestions: [{ id: 's1', improvedCode: 'const x = 1;' }],
                changedFiles: [
                    { filename: 'test.ts', fileContent: 'var x = 1;' } as any,
                ],
            });

            const result = await (stage as any).executeStage(context);

            expect(result.validSuggestions[0].isCommittable).toBeUndefined();
        });

        it('should skip when no valid suggestions', async () => {
            (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);

            const context = createBaseContext({
                validSuggestions: [],
                changedFiles: [
                    { filename: 'test.ts', fileContent: 'var x = 1;' } as any,
                ],
            });

            const result = await (stage as any).executeStage(context);

            expect(result).toBeDefined();
        });

        it('should skip when no changed files', async () => {
            (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);

            const context = createBaseContext({
                validSuggestions: [{ id: 's1', improvedCode: 'const x = 1;' }],
                changedFiles: [],
            });

            const result = await (stage as any).executeStage(context);

            expect(result).toBeDefined();
        });
    });

    describe('filterComplexSuggestions', () => {
        beforeEach(() => {
            (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);
        });

        it('should filter out suggestions exceeding character threshold', async () => {
            // MAX_CHARS_THRESHOLD = 1000
            const longCode = 'x'.repeat(1001);

            mockSuggestionLLMValidator.checkSuggestionSimplicity.mockResolvedValue({
                isSimple: true,
                reason: null,
            });

            const context = createBaseContext({
                validSuggestions: [
                    { id: 's1', improvedCode: longCode, llmPrompt: 'test' },
                ],
                changedFiles: [
                    { filename: 'test.ts', fileContent: 'var x;' } as any,
                ],
            });

            const result = await (stage as any).executeStage(context);

            // Suggestion should not be marked as committable due to being too long
            const suggestion = result.validSuggestions.find(
                (s) => s.id === 's1',
            );
            expect(suggestion?.isCommittable).toBeUndefined();
        });

        it('should filter out suggestions exceeding line threshold', async () => {
            // MAX_LINES_THRESHOLD = 15
            const manyLines = Array(16).fill('const x = 1;').join('\n');

            mockSuggestionLLMValidator.checkSuggestionSimplicity.mockResolvedValue({
                isSimple: true,
                reason: null,
            });

            const context = createBaseContext({
                validSuggestions: [
                    { id: 's1', improvedCode: manyLines, llmPrompt: 'test' },
                ],
                changedFiles: [
                    { filename: 'test.ts', fileContent: 'var x;' } as any,
                ],
            });

            const result = await (stage as any).executeStage(context);

            const suggestion = result.validSuggestions.find(
                (s) => s.id === 's1',
            );
            expect(suggestion?.isCommittable).toBeUndefined();
        });

        it('should filter out complex suggestions based on AST analysis', async () => {
            mockSuggestionLLMValidator.checkSuggestionSimplicity.mockResolvedValue({
                isSimple: false,
                reason: 'Contains complex structural changes',
            });

            const context = createBaseContext({
                validSuggestions: [
                    {
                        id: 's1',
                        improvedCode: 'const x = 1;',
                        llmPrompt: 'test',
                    },
                ],
                changedFiles: [
                    { filename: 'test.ts', fileContent: 'var x;' } as any,
                ],
            });

            const result = await (stage as any).executeStage(context);

            const suggestion = result.validSuggestions.find(
                (s) => s.id === 's1',
            );
            expect(suggestion?.isCommittable).toBeUndefined();
        });

        it('should pass through simple suggestions', async () => {
            mockSuggestionLLMValidator.checkSuggestionSimplicity.mockResolvedValue({
                isSimple: true,
                reason: null,
            });

            mockSuggestionLLMValidator.validateWithLLM.mockResolvedValue({
                isValid: true,
            });
            mockSandboxSyntaxValidator.validateFiles.mockResolvedValue(new Set(['s1']));

            (applyEdit as jest.Mock).mockResolvedValue({
                mergedCode: 'const x = 1;',
                udiff: `--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-var x;
+const x = 1;`,
            });

            const context = createBaseContext({
                validSuggestions: [
                    {
                        id: 's1',
                        relevantFile: 'test.ts',
                        improvedCode: 'const x = 1;',
                        llmPrompt: 'Use const',
                    },
                ],
                changedFiles: [
                    {
                        filename: 'test.ts',
                        fileContent: 'var x;',
                    } as any,
                ],
            });

            const result = await (stage as any).executeStage(context);

            const suggestion = result.validSuggestions.find(
                (s) => s.id === 's1',
            );
            expect(suggestion?.isCommittable).toBe(true);
            expect(suggestion?.validatedData).toBeDefined();
        });
    });

    describe('isLanguageSupported', () => {
        it('should support TypeScript files', () => {
            const result = (stage as any).isLanguageSupported('test.ts');
            expect(result).toBe(true);
        });

        it('should support JavaScript files', () => {
            const result = (stage as any).isLanguageSupported('test.js');
            expect(result).toBe(true);
        });

        it('should support Python files', () => {
            const result = (stage as any).isLanguageSupported('test.py');
            expect(result).toBe(true);
        });

        it('should not support binary files', () => {
            const result = (stage as any).isLanguageSupported('image.png');
            expect(result).toBe(false);
        });

        it('should not support files without extension', () => {
            const result = (stage as any).isLanguageSupported('Dockerfile');
            expect(result).toBe(false);
        });

        it('should handle various extensions', () => {
            // These are the supported languages defined in SUPPORTED_LANGUAGES
            expect((stage as any).isLanguageSupported('test.go')).toBe(true);
            expect((stage as any).isLanguageSupported('test.java')).toBe(true);
            expect((stage as any).isLanguageSupported('test.rb')).toBe(true);
            expect((stage as any).isLanguageSupported('test.php')).toBe(true);
            // tsx and jsx are NOT in SUPPORTED_LANGUAGES
            expect((stage as any).isLanguageSupported('test.tsx')).toBe(false);
            expect((stage as any).isLanguageSupported('test.jsx')).toBe(false);
        });
    });

    describe('groupSuggestionsByFile', () => {
        it('should group suggestions by their relevant file', () => {
            const suggestions = [
                { id: 's1', relevantFile: 'a.ts' },
                { id: 's2', relevantFile: 'a.ts' },
                { id: 's3', relevantFile: 'b.ts' },
            ];

            const files = [
                { filename: 'a.ts', fileContent: 'var a;' },
                { filename: 'b.ts', fileContent: 'var b;' },
            ];

            const result = (stage as any).groupSuggestionsByFile(
                suggestions,
                files,
            );

            expect(Object.keys(result)).toHaveLength(2);
            expect(result['a.ts'].suggestions).toHaveLength(2);
            expect(result['b.ts'].suggestions).toHaveLength(1);
        });

        it('should skip suggestions for files not in changed files list', () => {
            const suggestions = [
                { id: 's1', relevantFile: 'a.ts' },
                { id: 's2', relevantFile: 'nonexistent.ts' },
            ];

            const files = [{ filename: 'a.ts', fileContent: 'var a;' }];

            const result = (stage as any).groupSuggestionsByFile(
                suggestions,
                files,
            );

            expect(Object.keys(result)).toHaveLength(1);
            expect(result['a.ts'].suggestions).toHaveLength(1);
        });
    });

    describe('getFormattedSuggestionFromDiff', () => {
        it('should extract added lines from diff', () => {
            // The diff parser requires proper line counts in the hunk header
            const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,2 @@
-var x;
+const x = 1;
+const y = 2;`;

            const result = (stage as any).getFormattedSuggestionFromDiff(diff);

            expect(result).toEqual({
                code: 'const x = 1;\nconst y = 2;',
                startLine: 1,
                endLine: 1,
            });
        });

        it('should return null for multi-file diffs', () => {
            const diff = `--- a/test1.ts
+++ b/test1.ts
@@ -1 +1 @@
-var x;
+const x;
--- a/test2.ts
+++ b/test2.ts
@@ -1 +1 @@
-var y;
+const y;`;

            const result = (stage as any).getFormattedSuggestionFromDiff(diff);

            expect(result).toBeNull();
        });

        it('should return null for multi-hunk diffs', () => {
            const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-var x;
+const x;
@@ -10,1 +10,1 @@
-var y;
+const y;`;

            const result = (stage as any).getFormattedSuggestionFromDiff(diff);

            expect(result).toBeNull();
        });

        it('should return null for diffs exceeding line threshold', () => {
            const manyAddedLines = Array(20).fill('+const x = 1;').join('\n');
            const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,20 @@
-var x;
${manyAddedLines}`;

            const result = (stage as any).getFormattedSuggestionFromDiff(diff);

            expect(result).toBeNull();
        });
    });

    describe('error handling', () => {
        beforeEach(() => {
            (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);
        });

        it('should handle AST simplicity check errors gracefully', async () => {
            mockSuggestionLLMValidator.checkSuggestionSimplicity.mockRejectedValue(
                new Error('AST service unavailable'),
            );

            const context = createBaseContext({
                validSuggestions: [
                    {
                        id: 's1',
                        improvedCode: 'const x = 1;',
                        llmPrompt: 'test',
                    },
                ],
                changedFiles: [
                    { filename: 'test.ts', fileContent: 'var x;' } as any,
                ],
            });

            const result = await (stage as any).executeStage(context);

            // Should not crash, but suggestion won't be validated
            expect(result).toBeDefined();
        });

        it('should handle MorphLLM applyEdit errors gracefully', async () => {
            mockSuggestionLLMValidator.checkSuggestionSimplicity.mockResolvedValue({
                isSimple: true,
                reason: null,
            });

            (applyEdit as jest.Mock).mockRejectedValue(
                new Error('MorphLLM error'),
            );

            const context = createBaseContext({
                validSuggestions: [
                    {
                        id: 's1',
                        relevantFile: 'test.ts',
                        improvedCode: 'const x = 1;',
                        llmPrompt: 'Use const',
                    },
                ],
                changedFiles: [
                    {
                        filename: 'test.ts',
                        fileContent: 'var x;',
                    } as any,
                ],
            });

            const result = await (stage as any).executeStage(context);

            // Should not crash
            expect(result).toBeDefined();
        });

        it('should handle validation sandbox failure gracefully', async () => {
            mockSuggestionLLMValidator.checkSuggestionSimplicity.mockResolvedValue({
                isSimple: true,
                reason: null,
            });

            // Sandbox validation fails — should fall back to LLM-only
            mockSandboxSyntaxValidator.validateFiles.mockResolvedValue(new Set(['s1']));
            mockSuggestionLLMValidator.validateWithLLM.mockRejectedValue(
                new Error('LLM timeout'),
            );

            (applyEdit as jest.Mock).mockResolvedValue({
                mergedCode: 'const x = 1;',
                udiff: `--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-var x;
+const x = 1;`,
            });

            const context = createBaseContext({
                validSuggestions: [
                    {
                        id: 's1',
                        relevantFile: 'test.ts',
                        improvedCode: 'const x = 1;',
                        llmPrompt: 'Use const',
                    },
                ],
                changedFiles: [
                    {
                        filename: 'test.ts',
                        fileContent: 'var x;',
                    } as any,
                ],
            });

            // Should not crash — LLM error is caught per-candidate
            const result = await (stage as any).executeStage(context);
            expect(result).toBeDefined();
        });
    });
});
