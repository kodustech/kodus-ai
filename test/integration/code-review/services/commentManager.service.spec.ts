import { Test, TestingModule } from '@nestjs/testing';
import { CommentManagerService } from '@libs/code-review/infrastructure/adapters/services/commentManager.service';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { MessageTemplateProcessor } from '@libs/code-review/infrastructure/adapters/services/messageTemplateProcessor.service';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import {
    CodeSuggestion,
    Comment,
    FallbackSuggestionsBySeverity,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

describe('CommentManagerService - createLineComments retry logic', () => {
    let service: CommentManagerService;
    let mockCodeManagementService: any;

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const mockRepository = {
        id: 'repo-1',
        name: 'test-repo',
        language: 'TypeScript',
    };

    const mockCommit = {
        sha: 'abc123',
    };

    const createMockComment = (overrides?: Partial<Comment>): Comment => ({
        path: 'src/test.ts',
        body: 'Test comment body',
        line: 20,
        start_line: 15,
        side: 'RIGHT',
        start_side: 'RIGHT',
        suggestion: {
            id: 'suggestion-1',
            relevantFile: 'src/test.ts',
            suggestionContent: 'Test suggestion',
            existingCode: 'old code',
            improvedCode: 'new code',
            oneSentenceSummary: 'Test summary',
            relevantLinesStart: 15,
            relevantLinesEnd: 20,
            label: 'improvement',
            severity: 'medium',
        } as any,
        ...overrides,
    });

    beforeEach(async () => {
        mockCodeManagementService = {
            getCommitsForPullRequestForCodeReview: jest
                .fn()
                .mockResolvedValue([mockCommit]),
            createReviewComment: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CommentManagerService,
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: {},
                },
                {
                    provide: MessageTemplateProcessor,
                    useValue: {},
                },
                {
                    provide: PromptRunnerService,
                    useValue: {},
                },
                {
                    provide: ObservabilityService,
                    useValue: {},
                },
                {
                    provide: PermissionValidationService,
                    useValue: {},
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        service = module.get<CommentManagerService>(CommentManagerService);
    });

    describe('Test 1: Comment succeeds on first attempt', () => {
        it('should create comment successfully on first try', async () => {
            const mockComment = createMockComment();
            const mockCreatedComment = {
                id: 123,
                pullRequestReviewId: '456',
                body: 'Created comment',
            };

            mockCodeManagementService.createReviewComment.mockResolvedValue(
                mockCreatedComment,
            );

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.SENT,
            );
            expect(
                result.commentResults[0].codeReviewFeedbackData?.commentId,
            ).toBe(123);
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(1);
        });
    });

    describe('Test 2: Line mismatch on attempt 1, succeeds on attempt 2 (start_line = line)', () => {
        it('should retry with start_line = line when first attempt fails with line mismatch', async () => {
            const mockComment = createMockComment({
                start_line: 15,
                line: 20,
            });
            const mockCreatedComment = {
                id: 123,
                pullRequestReviewId: '456',
            };

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(lineMismatchError)
                .mockResolvedValueOnce(mockCreatedComment);

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.SENT,
            );
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(2);

            // Verify second call has start_line = line (both equal to 20)
            const secondCall =
                mockCodeManagementService.createReviewComment.mock.calls[1][0];
            expect(secondCall.lineComment.start_line).toBe(20);
            expect(secondCall.lineComment.line).toBe(20);
        });
    });

    describe('Test 3: Line mismatch on attempts 1 and 2, succeeds on attempt 3 (line = start_line)', () => {
        it('should retry with line = start_line when first two attempts fail with line mismatch', async () => {
            const mockComment = createMockComment({
                start_line: 15,
                line: 20,
            });
            const mockCreatedComment = {
                id: 123,
                pullRequestReviewId: '456',
            };

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(lineMismatchError) // Attempt 1 fails
                .mockRejectedValueOnce(lineMismatchError) // Attempt 2 fails
                .mockResolvedValueOnce(mockCreatedComment); // Attempt 3 succeeds

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.SENT,
            );
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(3);

            // Verify third call has line = start_line (both equal to 15)
            const thirdCall =
                mockCodeManagementService.createReviewComment.mock.calls[2][0];
            expect(thirdCall.lineComment.start_line).toBe(15);
            expect(thirdCall.lineComment.line).toBe(15);
        });
    });

    describe('Test 4: All 3 attempts fail with line mismatch', () => {
        it('should propagate error when all line mismatch retries fail', async () => {
            const mockComment = createMockComment({
                start_line: 15,
                line: 20,
            });

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(lineMismatchError) // Attempt 1 fails
                .mockRejectedValueOnce(lineMismatchError) // Attempt 2 fails
                .mockRejectedValueOnce(lineMismatchError); // Attempt 3 fails

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(
                'failed_lines_mismatch',
            );
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(3);
        });
    });

    describe('Test 5: Transient error (500), retry after 500ms succeeds', () => {
        it('should retry after 500ms delay when 500 error occurs', async () => {
            const mockComment = createMockComment();
            const mockCreatedComment = {
                id: 123,
                pullRequestReviewId: '456',
            };

            const transientError = {
                status: 500,
                message: 'Internal Server Error',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(transientError)
                .mockResolvedValueOnce(mockCreatedComment);

            const startTime = Date.now();

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            const elapsedTime = Date.now() - startTime;

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.SENT,
            );
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(2);

            // Verify delay was respected (at least 450ms to account for execution time variance)
            expect(elapsedTime).toBeGreaterThanOrEqual(450);
        });
    });

    describe('Test 6: Network error (ECONNRESET), retry succeeds', () => {
        it('should retry when network error occurs', async () => {
            const mockComment = createMockComment();
            const mockCreatedComment = {
                id: 123,
                pullRequestReviewId: '456',
            };

            const networkError = {
                code: 'ECONNRESET',
                message: 'Connection reset',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(networkError)
                .mockResolvedValueOnce(mockCreatedComment);

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.SENT,
            );
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(2);
        });
    });

    describe('Test 7: Definitive error (401/403/404), no retry', () => {
        it('should not retry on 401 Unauthorized error', async () => {
            const mockComment = createMockComment();

            const authError = {
                status: 401,
                message: 'Unauthorized',
            };

            mockCodeManagementService.createReviewComment.mockRejectedValueOnce(
                authError,
            );

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.FAILED,
            );
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(1);
        });

        it('should not retry on 403 Forbidden error', async () => {
            const mockComment = createMockComment();

            const forbiddenError = {
                status: 403,
                message: 'Forbidden',
            };

            mockCodeManagementService.createReviewComment.mockRejectedValueOnce(
                forbiddenError,
            );

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.FAILED,
            );
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(1);
        });

        it('should not retry on 404 Not Found error', async () => {
            const mockComment = createMockComment();

            const notFoundError = {
                status: 404,
                message: 'Not Found',
            };

            mockCodeManagementService.createReviewComment.mockRejectedValueOnce(
                notFoundError,
            );

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.FAILED,
            );
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(1);
        });
    });
});

describe('CommentManagerService - fallback suggestion logic', () => {
    let service: CommentManagerService;
    let mockCodeManagementService: any;

    const mockOrganizationAndTeamData = {
        organizationId: 'org-123',
        teamId: 'team-456',
    };

    const mockRepository = {
        id: 'repo-1',
        name: 'test-repo',
        language: 'TypeScript',
    };

    const mockCommit = {
        sha: 'abc123',
    };

    const createMockComment = (overrides?: Partial<Comment>): Comment => ({
        path: 'src/test.ts',
        body: 'Test comment body',
        line: 20,
        start_line: 15,
        side: 'RIGHT',
        start_side: 'RIGHT',
        suggestion: {
            id: 'suggestion-1',
            relevantFile: 'src/test.ts',
            suggestionContent: 'Test suggestion',
            existingCode: 'old code',
            improvedCode: 'new code',
            oneSentenceSummary: 'Test summary',
            relevantLinesStart: 15,
            relevantLinesEnd: 20,
            label: 'improvement',
            severity: 'critical',
        } as any,
        ...overrides,
    });

    const createMockFallbackSuggestion = (
        id: string,
        severity: string,
        overrides?: Partial<CodeSuggestion>,
    ): Partial<CodeSuggestion> => ({
        id,
        relevantFile: `src/fallback-${id}.ts`,
        suggestionContent: `Fallback suggestion ${id}`,
        existingCode: 'old code',
        improvedCode: 'new code',
        oneSentenceSummary: `Fallback summary ${id}`,
        relevantLinesStart: 10,
        relevantLinesEnd: 15,
        label: 'improvement',
        severity,
        priorityStatus: PriorityStatus.DISCARDED_BY_QUANTITY,
        ...overrides,
    });

    beforeEach(async () => {
        mockCodeManagementService = {
            getCommitsForPullRequestForCodeReview: jest
                .fn()
                .mockResolvedValue([mockCommit]),
            createReviewComment: jest.fn(),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CommentManagerService,
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: {},
                },
                {
                    provide: MessageTemplateProcessor,
                    useValue: {},
                },
                {
                    provide: PromptRunnerService,
                    useValue: {},
                },
                {
                    provide: ObservabilityService,
                    useValue: {},
                },
                {
                    provide: PermissionValidationService,
                    useValue: {},
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
            ],
        }).compile();

        service = module.get<CommentManagerService>(CommentManagerService);
    });

    describe('Test 8: Original fails, fallback of same severity succeeds', () => {
        it('should use fallback suggestion when original fails all retries', async () => {
            const mockComment = createMockComment();
            const fallbackSuggestion = createMockFallbackSuggestion(
                'fallback-1',
                'critical',
            );
            const fallbackSuggestionsBySeverity: FallbackSuggestionsBySeverity =
                {
                    critical: [fallbackSuggestion],
                    high: [],
                    medium: [],
                    low: [],
                };

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };
            const mockCreatedComment = {
                id: 999,
                pullRequestReviewId: '888',
            };

            // Original fails all 3 attempts, fallback succeeds
            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 1
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 2
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 3
                .mockResolvedValueOnce(mockCreatedComment); // Fallback succeeds

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
                undefined,
                fallbackSuggestionsBySeverity,
            );

            // Should have 2 results: original (REPLACED) + fallback (SENT)
            expect(result.commentResults).toHaveLength(2);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.REPLACED,
            );
            expect(result.commentResults[1].deliveryStatus).toBe(
                DeliveryStatus.SENT,
            );
            expect(
                result.commentResults[1].codeReviewFeedbackData?.commentId,
            ).toBe(999);

            // Fallback suggestion should be marked as REPRIORIZED
            expect(fallbackSuggestion.priorityStatus).toBe(
                PriorityStatus.REPRIORIZED,
            );

            // 3 attempts for original + 1 for fallback = 4 calls
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(4);
        });
    });

    describe('Test 9: Original fails, first fallback fails, second fallback succeeds', () => {
        it('should try multiple fallbacks until one succeeds', async () => {
            const mockComment = createMockComment();
            const fallbackSuggestion1 = createMockFallbackSuggestion(
                'fallback-1',
                'critical',
            );
            const fallbackSuggestion2 = createMockFallbackSuggestion(
                'fallback-2',
                'critical',
            );
            const fallbackSuggestionsBySeverity: FallbackSuggestionsBySeverity =
                {
                    critical: [fallbackSuggestion1, fallbackSuggestion2],
                    high: [],
                    medium: [],
                    low: [],
                };

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };
            const mockCreatedComment = {
                id: 777,
                pullRequestReviewId: '666',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 1
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 2
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 3
                .mockRejectedValueOnce(lineMismatchError) // Fallback 1 attempt 1
                .mockRejectedValueOnce(lineMismatchError) // Fallback 1 attempt 2
                .mockRejectedValueOnce(lineMismatchError) // Fallback 1 attempt 3
                .mockResolvedValueOnce(mockCreatedComment); // Fallback 2 succeeds

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
                undefined,
                fallbackSuggestionsBySeverity,
            );

            expect(result.commentResults).toHaveLength(2);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.REPLACED,
            );
            expect(result.commentResults[1].deliveryStatus).toBe(
                DeliveryStatus.SENT,
            );

            // Both fallbacks should be marked as REPRIORIZED
            expect(fallbackSuggestion1.priorityStatus).toBe(
                PriorityStatus.REPRIORIZED,
            );
            expect(fallbackSuggestion2.priorityStatus).toBe(
                PriorityStatus.REPRIORIZED,
            );

            // 3 for original + 3 for fallback1 + 1 for fallback2 = 7 calls
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(7);
        });
    });

    describe('Test 10: Original fails, no fallback available for severity', () => {
        it('should return FAILED when no fallback suggestions exist for severity', async () => {
            const mockComment = createMockComment(); // severity: critical
            const fallbackSuggestionsBySeverity: FallbackSuggestionsBySeverity =
                {
                    critical: [], // No critical fallbacks
                    high: [
                        createMockFallbackSuggestion('fallback-high', 'high'),
                    ],
                    medium: [],
                    low: [],
                };

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(lineMismatchError)
                .mockRejectedValueOnce(lineMismatchError)
                .mockRejectedValueOnce(lineMismatchError);

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
                undefined,
                fallbackSuggestionsBySeverity,
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(
                'failed_lines_mismatch',
            );
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(3);
        });
    });

    describe('Test 11: Original fails, all fallbacks also fail', () => {
        it('should return FAILED when all fallbacks are exhausted', async () => {
            const mockComment = createMockComment();
            const fallbackSuggestion = createMockFallbackSuggestion(
                'fallback-1',
                'critical',
            );
            const fallbackSuggestionsBySeverity: FallbackSuggestionsBySeverity =
                {
                    critical: [fallbackSuggestion],
                    high: [],
                    medium: [],
                    low: [],
                };

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };

            // All attempts fail
            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 1
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 2
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 3
                .mockRejectedValueOnce(lineMismatchError) // Fallback attempt 1
                .mockRejectedValueOnce(lineMismatchError) // Fallback attempt 2
                .mockRejectedValueOnce(lineMismatchError); // Fallback attempt 3

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
                undefined,
                fallbackSuggestionsBySeverity,
            );

            expect(result.commentResults).toHaveLength(1);
            expect(result.commentResults[0].deliveryStatus).toBe(
                'failed_lines_mismatch',
            );

            // Fallback should still be marked as REPRIORIZED (was attempted)
            expect(fallbackSuggestion.priorityStatus).toBe(
                PriorityStatus.REPRIORIZED,
            );

            // 3 for original + 3 for fallback = 6 calls
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(6);
        });
    });

    describe('Test 12: Skips already repriorized fallback suggestions', () => {
        it('should not attempt fallbacks that are already REPRIORIZED', async () => {
            const mockComment = createMockComment();
            const alreadyRepriorizedFallback = createMockFallbackSuggestion(
                'fallback-1',
                'critical',
                { priorityStatus: PriorityStatus.REPRIORIZED },
            );
            const availableFallback = createMockFallbackSuggestion(
                'fallback-2',
                'critical',
            );
            const fallbackSuggestionsBySeverity: FallbackSuggestionsBySeverity =
                {
                    critical: [alreadyRepriorizedFallback, availableFallback],
                    high: [],
                    medium: [],
                    low: [],
                };

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };
            const mockCreatedComment = {
                id: 555,
                pullRequestReviewId: '444',
            };

            mockCodeManagementService.createReviewComment
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 1
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 2
                .mockRejectedValueOnce(lineMismatchError) // Original attempt 3
                .mockResolvedValueOnce(mockCreatedComment); // Available fallback succeeds (skips repriorized)

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [mockComment],
                'en-US',
                { enabled: false },
                undefined,
                fallbackSuggestionsBySeverity,
            );

            expect(result.commentResults).toHaveLength(2);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.REPLACED,
            );
            expect(result.commentResults[1].deliveryStatus).toBe(
                DeliveryStatus.SENT,
            );

            // First fallback stays REPRIORIZED, second becomes REPRIORIZED
            expect(alreadyRepriorizedFallback.priorityStatus).toBe(
                PriorityStatus.REPRIORIZED,
            );
            expect(availableFallback.priorityStatus).toBe(
                PriorityStatus.REPRIORIZED,
            );

            // 3 for original + 1 for available fallback = 4 calls (skipped repriorized one)
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(4);
        });
    });

    describe('Test 13: Multiple comments, one fails and uses fallback', () => {
        it('should handle mixed success/fallback scenarios correctly', async () => {
            const successComment = createMockComment({
                suggestion: {
                    id: 'success-1',
                    relevantFile: 'src/success.ts',
                    suggestionContent: 'Success suggestion',
                    existingCode: 'old',
                    improvedCode: 'new',
                    relevantLinesStart: 10,
                    relevantLinesEnd: 15,
                    label: 'improvement',
                    severity: 'high',
                } as any,
            });
            const failComment = createMockComment({
                suggestion: {
                    id: 'fail-1',
                    relevantFile: 'src/fail.ts',
                    suggestionContent: 'Fail suggestion',
                    existingCode: 'old',
                    improvedCode: 'new',
                    relevantLinesStart: 20,
                    relevantLinesEnd: 25,
                    label: 'improvement',
                    severity: 'critical',
                } as any,
            });

            const fallbackSuggestion = createMockFallbackSuggestion(
                'fallback-critical',
                'critical',
            );
            const fallbackSuggestionsBySeverity: FallbackSuggestionsBySeverity =
                {
                    critical: [fallbackSuggestion],
                    high: [],
                    medium: [],
                    low: [],
                };

            const lineMismatchError = {
                errorType: 'failed_lines_mismatch',
                message: 'line must be part of the diff',
            };
            const mockCreatedComment1 = { id: 111, pullRequestReviewId: '222' };
            const mockCreatedComment2 = { id: 333, pullRequestReviewId: '444' };

            mockCodeManagementService.createReviewComment
                .mockResolvedValueOnce(mockCreatedComment1) // First comment succeeds
                .mockRejectedValueOnce(lineMismatchError) // Second comment fails attempt 1
                .mockRejectedValueOnce(lineMismatchError) // Second comment fails attempt 2
                .mockRejectedValueOnce(lineMismatchError) // Second comment fails attempt 3
                .mockResolvedValueOnce(mockCreatedComment2); // Fallback succeeds

            const result = await service.createLineComments(
                mockOrganizationAndTeamData as any,
                1,
                mockRepository,
                [successComment, failComment],
                'en-US',
                { enabled: false },
                undefined,
                fallbackSuggestionsBySeverity,
            );

            // 3 results: success, replaced, fallback sent
            expect(result.commentResults).toHaveLength(3);
            expect(result.commentResults[0].deliveryStatus).toBe(
                DeliveryStatus.SENT,
            );
            expect(result.commentResults[1].deliveryStatus).toBe(
                DeliveryStatus.REPLACED,
            );
            expect(result.commentResults[2].deliveryStatus).toBe(
                DeliveryStatus.SENT,
            );

            // 1 for success + 3 for fail + 1 for fallback = 5 calls
            expect(
                mockCodeManagementService.createReviewComment,
            ).toHaveBeenCalledTimes(5);
        });
    });
});
