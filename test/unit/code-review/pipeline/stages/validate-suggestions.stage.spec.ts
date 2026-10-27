import { Test, TestingModule } from '@nestjs/testing';
import { ValidateSuggestionsStage } from '@/code-review/pipeline/stages/validate-suggestions.stage';
import { SandboxSyntaxValidator } from '@/code-review/infrastructure/adapters/services/sandboxSyntaxValidator.service';
import { SuggestionLLMValidator } from '@/code-review/infrastructure/adapters/services/suggestionLLMValidator.service';
import { CodeReviewPipelineContext } from '@/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@/core/domain/enums';

// Mock logger to silence logs during tests
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

// Mock morphsdk
jest.mock('@morphllm/morphsdk', () => ({
    applyEdit: jest.fn(),
}));

import { applyEdit } from '@morphllm/morphsdk';

describe('ValidateSuggestionsStage', () => {
    let stage: ValidateSuggestionsStage;

    const mockSandboxSyntaxValidator = {
        validateFiles: jest.fn(),
    };

    const mockSuggestionLLMValidator = {
        validateWithLLM: jest.fn(),
        checkSuggestionSimplicity: jest.fn(),
    };

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const SIMPLE_UDIFF = `--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-var x;
+const x = 1;`;

    const createBaseContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ) => ({
        organizationAndTeamData: mockOrganizationAndTeamData as any,
        pullRequest: { number: 123 },
        platformType: PlatformType.GITHUB,
        codeReviewConfig: {
            enableCommittableSuggestions: true,
        } as any,
        validSuggestions: [
            {
                id: 's1',
                relevantFile: 'test.ts',
                improvedCode: 'const x = 1;',
                llmPrompt: 'Use const',
            },
        ],
        changedFiles: [{ filename: 'test.ts', fileContent: 'var x;' } as any],
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

        jest.resetAllMocks();
        mockSuggestionLLMValidator.checkSuggestionSimplicity.mockResolvedValue({
            isSimple: true,
            reason: null,
        });
        mockSuggestionLLMValidator.validateWithLLM.mockResolvedValue({
            isValid: true,
        });
        mockSandboxSyntaxValidator.validateFiles.mockResolvedValue(
            new Set(['s1']),
        );
        (applyEdit as jest.Mock).mockResolvedValue({
            mergedCode: 'const x = 1;',
            udiff: SIMPLE_UDIFF,
        });
    });

    it("marks a simple, validated suggestion committable, routing both validator calls through the pipeline's resolved BYOK slot", async () => {
        const byokConfig = { provider: 'openai', model: 'gpt-4o' } as any;
        const context = createBaseContext({
            codeReviewConfig: {
                enableCommittableSuggestions: true,
                resolvedModelSlot: byokConfig,
            } as any,
        });

        const result = await (stage as any).executeStage(context);

        const suggestion = result.validSuggestions.find((s) => s.id === 's1');
        expect(suggestion?.isCommittable).toBe(true);
        expect(suggestion?.validatedData).toEqual({
            code: 'const x = 1;',
            diff: SIMPLE_UDIFF,
            lineStart: 1,
            lineEnd: 1,
        });
        expect(
            mockSuggestionLLMValidator.checkSuggestionSimplicity,
        ).toHaveBeenCalledWith(
            mockOrganizationAndTeamData,
            123,
            expect.objectContaining({ id: 's1' }),
            byokConfig,
        );
        expect(
            mockSuggestionLLMValidator.validateWithLLM,
        ).toHaveBeenCalledWith(
            expect.anything(),
            mockOrganizationAndTeamData,
            123,
            byokConfig,
        );
    });

    it('only treats files with a supported extension as validatable', () => {
        const supported = (f: string) => (stage as any).isLanguageSupported(f);
        for (const f of ['a.ts', 'a.js', 'a.py', 'a.go', 'a.java', 'a.rb', 'a.php']) {
            expect(supported(f)).toBe(true);
        }
        // tsx and jsx are NOT in SUPPORTED_LANGUAGES
        for (const f of ['a.tsx', 'a.jsx', 'image.png', 'Dockerfile']) {
            expect(supported(f)).toBe(false);
        }
    });

    it('groups suggestions per changed file and drops those for files outside the PR', () => {
        const result = (stage as any).groupSuggestionsByFile(
            [
                { id: 's1', relevantFile: 'a.ts' },
                { id: 's2', relevantFile: 'a.ts' },
                { id: 's3', relevantFile: 'b.ts' },
                { id: 's4', relevantFile: 'nonexistent.ts' },
            ],
            [
                { filename: 'a.ts', fileContent: 'var a;' },
                { filename: 'b.ts', fileContent: 'var b;' },
            ],
        );

        expect(Object.keys(result)).toEqual(['a.ts', 'b.ts']);
        expect(result['a.ts'].suggestions.map((s) => s.id)).toEqual(['s1', 's2']);
        expect(result['b.ts'].suggestions.map((s) => s.id)).toEqual(['s3']);
    });

    // MAX_CHARS_THRESHOLD = 1000, MAX_LINES_THRESHOLD = 15. Today the only
    // observable effect of the thresholds is skipping the simplicity LLM
    // call: the suggestion still goes on to Morph + validation.
    it.each([
        ['at the character threshold', 'x'.repeat(1000)],
        ['at the line threshold', Array(15).fill('a;').join('\n')],
    ])('skips the simplicity LLM call for a suggestion %s', async (_label, improvedCode) => {
        await (stage as any).executeStage(
            createBaseContext({
                validSuggestions: [
                    { id: 's1', relevantFile: 'test.ts', improvedCode, llmPrompt: 'p' },
                ] as any,
            }),
        );

        expect(
            mockSuggestionLLMValidator.checkSuggestionSimplicity,
        ).not.toHaveBeenCalled();
    });

    it('asks the simplicity check for a suggestion just under both thresholds', async () => {
        await (stage as any).executeStage(
            createBaseContext({
                validSuggestions: [
                    {
                        id: 's1',
                        relevantFile: 'test.ts',
                        improvedCode: Array(14).fill('a;').join('\n'),
                        llmPrompt: 'p',
                    },
                ] as any,
            }),
        );

        expect(
            mockSuggestionLLMValidator.checkSuggestionSimplicity,
        ).toHaveBeenCalledTimes(1);
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

    describe('a per-suggestion failure does not fail the stage', () => {
        it('when MorphLLM applyEdit throws', async () => {
            (applyEdit as jest.Mock).mockRejectedValue(
                new Error('MorphLLM error'),
            );

            const result = await (stage as any).executeStage(
                createBaseContext(),
            );

            expect(result.validSuggestions[0].isCommittable).toBeUndefined();
        });

        it('when the simplicity check throws (the stage does not fail)', async () => {
            mockSuggestionLLMValidator.checkSuggestionSimplicity.mockRejectedValue(
                new Error('AST service unavailable'),
            );

            const result = await (stage as any).executeStage(
                createBaseContext(),
            );

            expect(result.validSuggestions.map((s) => s.id)).toEqual(['s1']);
        });

        it('when the LLM validation call throws', async () => {
            mockSuggestionLLMValidator.validateWithLLM.mockRejectedValue(
                new Error('LLM timeout'),
            );

            const result = await (stage as any).executeStage(
                createBaseContext(),
            );

            expect(result.validSuggestions[0].isCommittable).toBeUndefined();
        });
    });
});
