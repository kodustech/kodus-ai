import { Test, TestingModule } from '@nestjs/testing';
import { ValidateSuggestionsStage } from '@libs/code-review/pipeline/stages/validate-suggestions.stage';
import { SandboxSyntaxValidator } from '@libs/code-review/infrastructure/adapters/services/sandboxSyntaxValidator.service';
import { SuggestionLLMValidator } from '@libs/code-review/infrastructure/adapters/services/suggestionLLMValidator.service';
import {
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

// Mock logger
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
    default: { isFeatureEnabled: jest.fn() },
    FEATURE_FLAGS: { committableSuggestions: 'committable-suggestions' },
}));

// Mock morphsdk
jest.mock('@morphllm/morphsdk', () => ({
    applyEdit: jest.fn(),
}));

import { applyEdit } from '@morphllm/morphsdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate content of approximately `tokenCount` tokens (1 token ≈ 3.5 chars). */
function generateContent(tokenCount: number, seed = 'file'): string {
    const charCount = Math.floor(tokenCount * 3.5);
    const lines: string[] = [];
    let total = 0;
    let lineNum = 0;
    while (total < charCount) {
        const prefix = `${seed}_L${lineNum++}_`;
        const padding = 'x'.repeat(Math.max(0, 70 - prefix.length));
        const line = prefix + padding;
        lines.push(line);
        total += line.length + 1;
    }
    return lines.join('\n').slice(0, charCount);
}

function makeFile(filename: string, fileContent: string): FileChange {
    return { filename, fileContent, patch: '', status: 'modified' } as any;
}

function makeSuggestion(
    id: string,
    relevantFile: string,
): Partial<CodeSuggestion> {
    return {
        id,
        relevantFile,
        improvedCode: 'const x = 1;',
        llmPrompt: 'Use const',
        language: 'typescript',
    };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ValidateSuggestionsStage – maxInputTokens file skip', () => {
    let stage: ValidateSuggestionsStage;
    let stageAny: any;

    const mockSandboxSyntaxValidator = {
        validate: jest.fn().mockResolvedValue({ isValid: true, errors: [] }),
    };

    const mockSuggestionLLMValidator = {
        validate: jest.fn().mockResolvedValue({ isValid: true }),
    };

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
        stageAny = stage as any;
        jest.clearAllMocks();

        // Default: applyEdit returns a valid result
        (applyEdit as jest.Mock).mockResolvedValue({
            mergedCode: 'const x = 1;',
            udiff: `--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-var x;\n+const x = 1;`,
        });
    });

    // -----------------------------------------------------------------
    // We test prepareValidationCandidates directly (private, via `any`)
    // because it contains the skip logic and avoids needing to mock
    // the full AST validation pipeline.
    // -----------------------------------------------------------------

    describe('when maxInputTokens is NOT configured', () => {
        it('should process all files normally', async () => {
            const files = [
                makeFile('small.ts', 'const a = 1;'),
                makeFile('medium.ts', generateContent(5000, 'med')),
            ];

            const suggestions = [
                makeSuggestion('s1', 'small.ts'),
                makeSuggestion('s2', 'medium.ts'),
            ];

            const _candidates = await stageAny.prepareValidationCandidates(
                suggestions,
                files,
                undefined, // no maxInputTokens
            );

            // Both files should produce candidates (applyEdit mocked to succeed)
            expect(applyEdit).toHaveBeenCalledTimes(2);
        });
    });

    describe('when maxInputTokens is 0 or null', () => {
        it('should treat maxInputTokens=0 as not configured', async () => {
            const files = [makeFile('big.ts', generateContent(50000, 'big'))];
            const suggestions = [makeSuggestion('s1', 'big.ts')];

            await stageAny.prepareValidationCandidates(suggestions, files, 0);

            // File should NOT be skipped
            expect(applyEdit).toHaveBeenCalledTimes(1);
        });

        it('should treat maxInputTokens=null as not configured', async () => {
            const files = [makeFile('big.ts', generateContent(50000, 'big'))];
            const suggestions = [makeSuggestion('s1', 'big.ts')];

            await stageAny.prepareValidationCandidates(
                suggestions,
                files,
                null,
            );

            expect(applyEdit).toHaveBeenCalledTimes(1);
        });
    });

    describe('when maxInputTokens is set and file fits in budget', () => {
        it('should process the file normally', async () => {
            // Small file (~4 tokens), huge budget (100k)
            const files = [makeFile('small.ts', 'const a = 1;')];
            const suggestions = [makeSuggestion('s1', 'small.ts')];

            const candidates = await stageAny.prepareValidationCandidates(
                suggestions,
                files,
                100000,
            );

            expect(applyEdit).toHaveBeenCalledTimes(1);
            expect(candidates).toHaveLength(1);
        });
    });

    describe('when maxInputTokens is set and file exceeds budget', () => {
        it('should skip the file and generate no candidates for it', async () => {
            // File with ~50000 tokens, budget of 10000
            // effectiveBudget = floor(10000 * 0.9) = 9000
            // fileTokens ≈ 50000 >> 9000 → skip
            const largeContent = generateContent(50000, 'large');
            const files = [makeFile('large.ts', largeContent)];
            const suggestions = [makeSuggestion('s1', 'large.ts')];

            const candidates = await stageAny.prepareValidationCandidates(
                suggestions,
                files,
                10000,
            );

            // applyEdit should NOT have been called (file was skipped)
            expect(applyEdit).not.toHaveBeenCalled();
            expect(candidates).toHaveLength(0);
        });

        it('should skip all suggestions for that file', async () => {
            const largeContent = generateContent(50000, 'large');
            const files = [makeFile('large.ts', largeContent)];
            const suggestions = [
                makeSuggestion('s1', 'large.ts'),
                makeSuggestion('s2', 'large.ts'),
                makeSuggestion('s3', 'large.ts'),
            ];

            const candidates = await stageAny.prepareValidationCandidates(
                suggestions,
                files,
                10000,
            );

            // All 3 suggestions skipped because the file is too large
            expect(applyEdit).not.toHaveBeenCalled();
            expect(candidates).toHaveLength(0);
        });
    });

    describe('mixed files: some fit, some do not', () => {
        it('should only process files that fit in budget', async () => {
            // Small file fits, large file does not
            const smallContent = 'const a = 1;\nconst b = 2;';
            const largeContent = generateContent(50000, 'large');

            const files = [
                makeFile('small.ts', smallContent),
                makeFile('large.ts', largeContent),
            ];

            const suggestions = [
                makeSuggestion('s1', 'small.ts'),
                makeSuggestion('s2', 'large.ts'),
                makeSuggestion('s3', 'large.ts'),
            ];

            const _candidates = await stageAny.prepareValidationCandidates(
                suggestions,
                files,
                10000,
            );

            // Only small.ts suggestion should be processed
            expect(applyEdit).toHaveBeenCalledTimes(1);

            // Verify applyEdit was called with small file's content
            const applyEditCall = (applyEdit as jest.Mock).mock.calls[0][0];
            expect(applyEditCall.originalCode).toBe(smallContent);
        });

        it('should handle 3 files: 2 fit, 1 does not', async () => {
            const smallContent1 = 'const x = 1;';
            const smallContent2 = 'const y = 2;';
            const largeContent = generateContent(50000, 'huge');

            const files = [
                makeFile('a.ts', smallContent1),
                makeFile('b.ts', smallContent2),
                makeFile('huge.ts', largeContent),
            ];

            const suggestions = [
                makeSuggestion('s1', 'a.ts'),
                makeSuggestion('s2', 'b.ts'),
                makeSuggestion('s3', 'huge.ts'),
                makeSuggestion('s4', 'huge.ts'),
            ];

            const _candidates = await stageAny.prepareValidationCandidates(
                suggestions,
                files,
                10000,
            );

            // Only a.ts and b.ts processed (2 calls), huge.ts skipped
            expect(applyEdit).toHaveBeenCalledTimes(2);

            const processedFiles = (applyEdit as jest.Mock).mock.calls.map(
                (call) => call[0].filepath,
            );
            expect(processedFiles).toContain('a.ts');
            expect(processedFiles).toContain('b.ts');
            expect(processedFiles).not.toContain('huge.ts');
        });
    });

    describe('budget boundary', () => {
        it('should process file when tokens exactly equal the budget', async () => {
            // effectiveBudget = floor(10000 * 0.9) = 9000 tokens
            // File with exactly 9000 tokens should fit (not strictly greater)
            const content = generateContent(9000, 'exact');
            const files = [makeFile('exact.ts', content)];
            const suggestions = [makeSuggestion('s1', 'exact.ts')];

            const _candidates = await stageAny.prepareValidationCandidates(
                suggestions,
                files,
                10000,
            );

            // estimateTokens(content) = ceil(chars / 3.5)
            // generateContent(9000) produces floor(9000*3.5) = 31500 chars
            // estimateTokens(31500 chars) = ceil(31500/3.5) = 9000
            // 9000 <= 9000 → should process (not strictly greater)
            expect(applyEdit).toHaveBeenCalledTimes(1);
        });

        it('should skip file when tokens exceed the budget', async () => {
            // effectiveBudget = floor(10000 * 0.9) = 9000
            // Use 10000 tokens to clearly exceed (avoids rounding edge cases
            // in generateContent where join('\n') produces fewer chars than
            // the internal counter estimates)
            const content = generateContent(10000, 'over');
            const files = [makeFile('over.ts', content)];
            const suggestions = [makeSuggestion('s1', 'over.ts')];

            const candidates = await stageAny.prepareValidationCandidates(
                suggestions,
                files,
                10000,
            );

            expect(applyEdit).not.toHaveBeenCalled();
            expect(candidates).toHaveLength(0);
        });
    });
});
