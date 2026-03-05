import { Test, TestingModule } from '@nestjs/testing';
import { CommentManagerService } from '@libs/code-review/infrastructure/adapters/services/commentManager.service';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { MessageTemplateProcessor } from '@libs/code-review/infrastructure/adapters/services/messageTemplateProcessor.service';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a file with a patch of approximately `tokenCount` tokens.
 * estimateTokens uses Math.ceil(text.length / 3.5), so we need ~tokenCount * 3.5 chars.
 */
function makeFile(filename: string, patchTokens: number): Partial<FileChange> {
    const charCount = Math.floor(patchTokens * 3.5);
    const patch =
        `${filename}_` +
        'x'.repeat(Math.max(0, charCount - filename.length - 1));
    return {
        filename,
        patch,
        status: 'modified',
    } as Partial<FileChange>;
}

// A short system prompt for tests (~200 chars ≈ 58 tokens)
const SHORT_PROMPT =
    'Analyze the code changes and generate a PR summary. Respond concisely. This is a test prompt that simulates the real system prompt used in production.';
const SHORT_PREFIX = '';

// ---------------------------------------------------------------------------
// Test suite: chunkChangedFilesForSummary (private method, tested via `any`)
// ---------------------------------------------------------------------------

describe('CommentManagerService – chunkChangedFilesForSummary', () => {
    let service: CommentManagerService;
    let serviceAny: any;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CommentManagerService,
                { provide: PARAMETERS_SERVICE_TOKEN, useValue: {} },
                { provide: MessageTemplateProcessor, useValue: {} },
                { provide: PromptRunnerService, useValue: {} },
                { provide: ObservabilityService, useValue: {} },
                { provide: PermissionValidationService, useValue: {} },
                { provide: CodeManagementService, useValue: {} },
            ],
        }).compile();

        service = module.get<CommentManagerService>(CommentManagerService);
        serviceAny = service as any;
    });

    // -----------------------------------------------------------------
    // No maxInputTokens configured
    // -----------------------------------------------------------------

    describe('when maxInputTokens is not configured', () => {
        it('should return all files in a single chunk when undefined', () => {
            const files = [makeFile('a.ts', 100), makeFile('b.ts', 100)];

            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                SHORT_PROMPT,
                SHORT_PREFIX,
                undefined,
            );

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(files); // Same reference
        });

        it('should return all files in a single chunk when 0', () => {
            const files = [makeFile('a.ts', 100), makeFile('b.ts', 100)];

            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                SHORT_PROMPT,
                SHORT_PREFIX,
                0,
            );

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(files);
        });

        it('should return all files in a single chunk when null', () => {
            const files = [makeFile('a.ts', 100)];

            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                SHORT_PROMPT,
                SHORT_PREFIX,
                null,
            );

            expect(result).toHaveLength(1);
        });
    });

    // -----------------------------------------------------------------
    // All files fit in budget
    // -----------------------------------------------------------------

    describe('when all files fit in budget', () => {
        it('should return a single chunk with all files', () => {
            // Small files, large budget
            const files = [
                makeFile('a.ts', 50),
                makeFile('b.ts', 50),
                makeFile('c.ts', 50),
            ];

            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                SHORT_PROMPT,
                SHORT_PREFIX,
                100000, // huge budget
            );

            expect(result).toHaveLength(1);
            expect(result[0]).toHaveLength(3);
        });
    });

    // -----------------------------------------------------------------
    // Files need splitting into 2–4 chunks
    // -----------------------------------------------------------------

    describe('when files need splitting into multiple chunks', () => {
        it('should split into 2 chunks when files exceed budget', () => {
            // Each file ≈ 2000 tokens. With maxInputTokens=5000,
            // effectiveBudget = floor(5000 * 0.9) = 4500
            // fixedTokens ≈ ~115 (short prompt + overhead)
            // availableTokens ≈ ~4385
            // JSON.stringify overhead makes each file ~7020 chars ≈ 2006 tokens
            // 2 files ≈ 4012 tokens < 4385 → fit
            // 3 files ≈ 6018 tokens > 4385 → split
            const files = [
                makeFile('a.ts', 2000),
                makeFile('b.ts', 2000),
                makeFile('c.ts', 2000),
                makeFile('d.ts', 2000),
            ];

            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                SHORT_PROMPT,
                SHORT_PREFIX,
                5000,
            );

            expect(result).not.toBeNull();
            expect(result.length).toBe(2);

            // All files should be accounted for
            const totalFiles = result.reduce(
                (sum: number, chunk: any[]) => sum + chunk.length,
                0,
            );
            expect(totalFiles).toBe(4);
        });

        it('should split into exactly 4 chunks', () => {
            // Each file ≈ 3000 tokens. With maxInputTokens=4000,
            // effectiveBudget = floor(4000 * 0.9) = 3600
            // fixedTokens ≈ ~115
            // availableTokens ≈ ~3485
            // Each file serialized ≈ ~3006 tokens → 1 file per chunk
            const files = [
                makeFile('a.ts', 3000),
                makeFile('b.ts', 3000),
                makeFile('c.ts', 3000),
                makeFile('d.ts', 3000),
            ];

            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                SHORT_PROMPT,
                SHORT_PREFIX,
                4000,
            );

            expect(result).not.toBeNull();
            expect(result.length).toBe(4);
        });

        it('should preserve file order across chunks', () => {
            const files = [
                makeFile('first.ts', 2000),
                makeFile('second.ts', 2000),
                makeFile('third.ts', 2000),
            ];

            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                SHORT_PROMPT,
                SHORT_PREFIX,
                3000,
            );

            expect(result).not.toBeNull();

            // Flatten and check order
            const allFiles = result.flat();
            expect(allFiles[0].filename).toBe('first.ts');
            expect(allFiles[1].filename).toBe('second.ts');
            expect(allFiles[2].filename).toBe('third.ts');
        });
    });

    // -----------------------------------------------------------------
    // More than 4 chunks → returns null
    // -----------------------------------------------------------------

    describe('when more than 4 chunks would be needed', () => {
        it('should return null', () => {
            // 5 large files, each ≈ 3000 tokens, budget allows ~1 per chunk
            // → 5 chunks needed → exceeds max 4
            const files = [
                makeFile('a.ts', 3000),
                makeFile('b.ts', 3000),
                makeFile('c.ts', 3000),
                makeFile('d.ts', 3000),
                makeFile('e.ts', 3000),
            ];

            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                SHORT_PROMPT,
                SHORT_PREFIX,
                4000,
            );

            expect(result).toBeNull();
        });

        it('should return null for many small files that overflow 4 chunks', () => {
            // 20 files of ~500 tokens each = ~10000 tokens total
            // budget = 1500, effectiveBudget = 1350, available ≈ 1235
            // Each file ≈ 510 tokens serialized → ~2 files per chunk
            // 20 files / 2 per chunk = 10 chunks → exceeds 4
            const files = Array.from({ length: 20 }, (_, i) =>
                makeFile(`file${i}.ts`, 500),
            );

            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                SHORT_PROMPT,
                SHORT_PREFIX,
                1500,
            );

            expect(result).toBeNull();
        });
    });

    // -----------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------

    describe('edge cases', () => {
        it('should return all files best-effort when budget is consumed by fixed parts', () => {
            // Very large prompt, tiny maxInputTokens
            const hugePrompt = 'x'.repeat(10000); // ≈ 2857 tokens
            const files = [makeFile('a.ts', 100)];

            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                hugePrompt,
                SHORT_PREFIX,
                1000, // effectiveBudget = 900, but fixedTokens ≈ 2907 > 900
            );

            // availableTokens <= 0 → return all files best-effort
            expect(result).toHaveLength(1);
            expect(result[0]).toBe(files);
        });

        it('should handle empty changedFiles array', () => {
            const result = serviceAny.chunkChangedFilesForSummary(
                [],
                SHORT_PROMPT,
                SHORT_PREFIX,
                10000,
            );

            // Empty array serialized = "[]" → fits any budget
            expect(result).toHaveLength(1);
            expect(result[0]).toHaveLength(0);
        });

        it('should handle single large file that needs its own chunk', () => {
            const files = [makeFile('huge.ts', 5000)];

            // Budget allows the file (it goes into 1 chunk)
            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                SHORT_PROMPT,
                SHORT_PREFIX,
                6000,
            );

            expect(result).toHaveLength(1);
            expect(result[0]).toHaveLength(1);
        });

        it('should handle mix of small and large files', () => {
            // budget: effectiveBudget = floor(3000 * 0.9) = 2700
            // fixedTokens ≈ ~115
            // availableTokens ≈ ~2585
            // tiny files ≈ 100 tokens each, big file ≈ 2500 tokens
            // tiny1+tiny2+big ≈ 2700 tokens serialized > 2585 → split
            const files = [
                makeFile('tiny1.ts', 100),
                makeFile('tiny2.ts', 100),
                makeFile('big.ts', 2500),
                makeFile('tiny3.ts', 100),
            ];

            const result = serviceAny.chunkChangedFilesForSummary(
                files,
                SHORT_PROMPT,
                SHORT_PREFIX,
                3000,
            );

            expect(result).not.toBeNull();
            expect(result.length).toBeGreaterThanOrEqual(2);

            // All files accounted for
            const totalFiles = result.reduce(
                (sum: number, chunk: any[]) => sum + chunk.length,
                0,
            );
            expect(totalFiles).toBe(4);
        });
    });
});

// ---------------------------------------------------------------------------
// Test suite: generateSummaryPR integration with chunking
// ---------------------------------------------------------------------------

describe('CommentManagerService – generateSummaryPR chunking integration', () => {
    let service: CommentManagerService;
    let mockObservabilityService: any;
    let mockCodeManagementService: any;
    let mockPermissionValidationService: any;
    let llmCallCount: number;

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const mockRepository = {
        id: 'repo-1',
        name: 'test-repo',
    };

    const mockPullRequest = {
        number: 42,
        title: 'Test PR',
        head: { ref: 'feature-branch', repo: { fullName: 'org/repo' } },
        base: { ref: 'main' },
    };

    const defaultSummaryConfig = {
        generatePRSummary: true,
        behaviourForExistingDescription: 'concatenate',
        behaviourForNewCommits: 'none',
    };

    beforeEach(async () => {
        llmCallCount = 0;

        mockObservabilityService = {
            runLLMInSpan: jest.fn().mockImplementation(async ({ runName }) => {
                llmCallCount++;
                if (runName.includes('consolidation')) {
                    return { result: 'Consolidated summary of all changes.' };
                }
                if (runName.includes('chunk')) {
                    const chunkNum = runName.match(/chunk_(\d+)/)?.[1] || '?';
                    return {
                        result: `Partial summary for chunk ${chunkNum}.`,
                    };
                }
                return { result: 'Full PR summary generated.' };
            }),
        };

        mockCodeManagementService = {
            getPullRequestByNumber: jest.fn().mockResolvedValue({
                body: 'Existing PR description',
            }),
        };

        mockPermissionValidationService = {
            validateBasicLicense: jest
                .fn()
                .mockResolvedValue({ allowed: true }),
            getBYOKConfig: jest.fn().mockResolvedValue(null),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CommentManagerService,
                { provide: PARAMETERS_SERVICE_TOKEN, useValue: {} },
                { provide: MessageTemplateProcessor, useValue: {} },
                { provide: PromptRunnerService, useValue: {} },
                {
                    provide: ObservabilityService,
                    useValue: mockObservabilityService,
                },
                {
                    provide: PermissionValidationService,
                    useValue: mockPermissionValidationService,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        service = module.get<CommentManagerService>(CommentManagerService);
    });

    describe('without maxInputTokens (no chunking)', () => {
        it('should make a single LLM call', async () => {
            const files = [makeFile('a.ts', 100), makeFile('b.ts', 100)];

            const result = await service.generateSummaryPR(
                mockPullRequest,
                mockRepository,
                files,
                mockOrganizationAndTeamData as any,
                'en-US',
                defaultSummaryConfig as any,
                undefined, // no byokConfig
            );

            expect(result).toContain('Full PR summary generated.');
            expect(llmCallCount).toBe(1);
        });
    });

    describe('with maxInputTokens, files fit in budget', () => {
        it('should make a single LLM call', async () => {
            const files = [makeFile('a.ts', 50)];

            const byokConfig = {
                main: {
                    provider: 'openai',
                    apiKey: 'test-key',
                    model: 'gpt-4o',
                    maxInputTokens: 100000,
                },
            };

            const result = await service.generateSummaryPR(
                mockPullRequest,
                mockRepository,
                files,
                mockOrganizationAndTeamData as any,
                'en-US',
                defaultSummaryConfig as any,
                byokConfig as any,
            );

            expect(result).toContain('Full PR summary generated.');
            expect(llmCallCount).toBe(1);
        });
    });

    describe('with maxInputTokens, files need 2 chunks', () => {
        it('should make 2 chunk calls + 1 consolidation call', async () => {
            // Each file ≈ 2000 tokens, budget allows ~1 file per chunk
            const files = [makeFile('a.ts', 2000), makeFile('b.ts', 2000)];

            const byokConfig = {
                main: {
                    provider: 'openai',
                    apiKey: 'test-key',
                    model: 'gpt-4o',
                    maxInputTokens: 3000,
                },
            };

            const result = await service.generateSummaryPR(
                mockPullRequest,
                mockRepository,
                files,
                mockOrganizationAndTeamData as any,
                'en-US',
                defaultSummaryConfig as any,
                byokConfig as any,
            );

            // 2 chunk calls + 1 consolidation = 3 total
            expect(llmCallCount).toBe(3);
            expect(result).toContain('Consolidated summary');

            // Verify chunk calls
            const calls = mockObservabilityService.runLLMInSpan.mock.calls;
            const runNames = calls.map((c: any) => c[0].runName);
            expect(runNames).toContain('generateSummaryPR_chunk_1');
            expect(runNames).toContain('generateSummaryPR_chunk_2');
            expect(runNames).toContain('generateSummaryPR_consolidation');
        });
    });

    describe('with maxInputTokens, files need >4 chunks', () => {
        it('should return null and skip summary generation', async () => {
            // 5 large files, budget allows ~1 per chunk → 5 chunks > 4
            const files = [
                makeFile('a.ts', 3000),
                makeFile('b.ts', 3000),
                makeFile('c.ts', 3000),
                makeFile('d.ts', 3000),
                makeFile('e.ts', 3000),
            ];

            const byokConfig = {
                main: {
                    provider: 'openai',
                    apiKey: 'test-key',
                    model: 'gpt-4o',
                    maxInputTokens: 4000,
                },
            };

            const result = await service.generateSummaryPR(
                mockPullRequest,
                mockRepository,
                files,
                mockOrganizationAndTeamData as any,
                'en-US',
                defaultSummaryConfig as any,
                byokConfig as any,
            );

            // Should return null — no summary generated
            expect(result).toBeNull();
            // No LLM calls should have been made for summary
            expect(llmCallCount).toBe(0);
        });
    });

    describe('with maxInputTokens, some chunks return empty', () => {
        it('should consolidate only non-empty partial summaries', async () => {
            // Override mock: chunk 2 returns empty
            mockObservabilityService.runLLMInSpan.mockImplementation(
                async ({ runName }: any) => {
                    llmCallCount++;
                    if (runName.includes('consolidation')) {
                        return {
                            result: 'Consolidated from partial summaries.',
                        };
                    }
                    if (runName === 'generateSummaryPR_chunk_2') {
                        return { result: null }; // empty chunk
                    }
                    if (runName.includes('chunk')) {
                        return { result: 'Partial summary for chunk.' };
                    }
                    return { result: 'Full summary.' };
                },
            );

            const files = [makeFile('a.ts', 2000), makeFile('b.ts', 2000)];

            const byokConfig = {
                main: {
                    provider: 'openai',
                    apiKey: 'test-key',
                    model: 'gpt-4o',
                    maxInputTokens: 3000,
                },
            };

            const result = await service.generateSummaryPR(
                mockPullRequest,
                mockRepository,
                files,
                mockOrganizationAndTeamData as any,
                'en-US',
                defaultSummaryConfig as any,
                byokConfig as any,
            );

            // 2 chunk calls + 1 consolidation = 3
            expect(llmCallCount).toBe(3);
            expect(result).toContain('Consolidated from partial summaries.');
        });
    });

    describe('with maxInputTokens, all chunks return empty', () => {
        it('should return null after retry exhaustion', async () => {
            // All chunk calls return empty
            mockObservabilityService.runLLMInSpan.mockImplementation(
                async () => {
                    llmCallCount++;
                    return { result: null };
                },
            );

            const files = [makeFile('a.ts', 2000), makeFile('b.ts', 2000)];

            const byokConfig = {
                main: {
                    provider: 'openai',
                    apiKey: 'test-key',
                    model: 'gpt-4o',
                    maxInputTokens: 3000,
                },
            };

            // generateSummaryPR has retry logic (maxRetries=2), and throws
            // when all chunks return empty, which gets caught and retried
            const result = await service.generateSummaryPR(
                mockPullRequest,
                mockRepository,
                files,
                mockOrganizationAndTeamData as any,
                'en-US',
                defaultSummaryConfig as any,
                byokConfig as any,
            );

            // After all retries exhausted, returns null
            expect(result).toBeNull();
        });
    });
});
