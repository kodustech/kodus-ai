import { SaveCodeReviewFeedbackUseCase } from '../save-feedback.use-case';
import { ReactionSyncAbortedError } from '@libs/code-review/domain/codeReviewFeedback/errors/reaction-sync-aborted.error';
import { isRateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { createSampleFeedbackEntity } from './fixtures';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('SaveCodeReviewFeedbackUseCase', () => {
    let useCase: SaveCodeReviewFeedbackUseCase;
    let codeReviewFeedbackService: {
        bulkUpsertReactions: jest.Mock;
        getByOrganizationId: jest.Mock;
    };
    let getReactionsUseCase: {
        execute: jest.Mock;
    };

    const payload = {
        organizationId: 'org-001',
        teamId: 'team-001',
        automationExecutionsPRs: [42],
    };

    const collectedReaction = (overrides?: {
        suggestionId?: string;
        reactions?: { thumbsUp: number; thumbsDown: number };
    }) => ({
        reactions: overrides?.reactions ?? { thumbsUp: 1, thumbsDown: 0 },
        comment: { id: 100, pullRequestReviewId: 'pr-review-200' },
        suggestionId: overrides?.suggestionId ?? 'suggestion-001',
        pullRequest: {
            id: 'pr-001',
            number: 42,
            repository: { id: 'repo-001', fullName: 'org/repo' },
        },
        organizationId: 'org-001',
    });

    beforeEach(() => {
        codeReviewFeedbackService = {
            bulkUpsertReactions: jest.fn().mockResolvedValue(0),
            getByOrganizationId: jest.fn().mockResolvedValue([]),
        };
        getReactionsUseCase = {
            execute: jest.fn().mockResolvedValue([]),
        };

        useCase = new SaveCodeReviewFeedbackUseCase(
            codeReviewFeedbackService as any,
            getReactionsUseCase as any,
        );
    });

    it('should fetch reactions for the PR range without filtering on prior state', async () => {
        codeReviewFeedbackService.getByOrganizationId.mockResolvedValue([
            createSampleFeedbackEntity({ suggestionId: 'suggestion-001' }),
        ]);

        await useCase.execute(payload);

        expect(getReactionsUseCase.execute).toHaveBeenCalledWith(
            { organizationId: 'org-001', teamId: 'team-001' },
            [42],
        );
    });

    it('should write reactions never stored before', async () => {
        const reaction = collectedReaction();
        getReactionsUseCase.execute.mockResolvedValue([reaction]);
        codeReviewFeedbackService.getByOrganizationId.mockResolvedValue([]);

        const result = await useCase.execute(payload);

        expect(
            codeReviewFeedbackService.bulkUpsertReactions,
        ).toHaveBeenCalledWith([reaction]);
        expect(result).toEqual([reaction]);
    });

    it('should refresh a stored reaction whose count moved', async () => {
        // Stored at 1 thumbs up, provider now reports 4
        codeReviewFeedbackService.getByOrganizationId.mockResolvedValue([
            createSampleFeedbackEntity({
                suggestionId: 'suggestion-001',
                reactions: { thumbsUp: 1, thumbsDown: 0 },
            }),
        ]);
        const refreshed = collectedReaction({
            reactions: { thumbsUp: 4, thumbsDown: 0 },
        });
        getReactionsUseCase.execute.mockResolvedValue([refreshed]);

        const result = await useCase.execute(payload);

        expect(
            codeReviewFeedbackService.bulkUpsertReactions,
        ).toHaveBeenCalledWith([refreshed]);
        expect(result).toEqual([refreshed]);
    });

    it('should not write when the stored count already matches', async () => {
        codeReviewFeedbackService.getByOrganizationId.mockResolvedValue([
            createSampleFeedbackEntity({
                suggestionId: 'suggestion-001',
                reactions: { thumbsUp: 1, thumbsDown: 0 },
            }),
        ]);
        getReactionsUseCase.execute.mockResolvedValue([
            collectedReaction({ reactions: { thumbsUp: 1, thumbsDown: 0 } }),
        ]);

        const result = await useCase.execute(payload);

        // Rewriting an unchanged doc would bump updatedAt and drag the whole
        // organization back through the analytics ingestion watermark
        expect(
            codeReviewFeedbackService.bulkUpsertReactions,
        ).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });

    it('should write only the entries that changed', async () => {
        codeReviewFeedbackService.getByOrganizationId.mockResolvedValue([
            createSampleFeedbackEntity({
                suggestionId: 'suggestion-001',
                reactions: { thumbsUp: 1, thumbsDown: 0 },
            }),
            createSampleFeedbackEntity({
                suggestionId: 'suggestion-002',
                reactions: { thumbsUp: 2, thumbsDown: 0 },
            }),
        ]);

        const unchanged = collectedReaction({
            suggestionId: 'suggestion-001',
            reactions: { thumbsUp: 1, thumbsDown: 0 },
        });
        const changed = collectedReaction({
            suggestionId: 'suggestion-002',
            reactions: { thumbsUp: 2, thumbsDown: 3 },
        });
        getReactionsUseCase.execute.mockResolvedValue([unchanged, changed]);

        await useCase.execute(payload);

        expect(
            codeReviewFeedbackService.bulkUpsertReactions,
        ).toHaveBeenCalledWith([changed]);
    });

    it('should return [] when getReactions returns empty', async () => {
        getReactionsUseCase.execute.mockResolvedValue([]);

        const result = await useCase.execute(payload);

        expect(
            codeReviewFeedbackService.bulkUpsertReactions,
        ).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });

    it('should propagate errors from getReactionsUseCase', async () => {
        getReactionsUseCase.execute.mockRejectedValue(
            new Error("Repository service for type 'null' not found."),
        );

        await expect(useCase.execute(payload)).rejects.toThrow(
            "Repository service for type 'null' not found.",
        );
    });

    it('should propagate errors from the write', async () => {
        getReactionsUseCase.execute.mockResolvedValue([collectedReaction()]);
        codeReviewFeedbackService.bulkUpsertReactions.mockRejectedValue(
            new Error('Database write failed'),
        );

        await expect(useCase.execute(payload)).rejects.toThrow(
            'Database write failed',
        );
    });

    describe('when the run is aborted by a provider rate limit', () => {
        const abortedError = (partialReactions: any[]) =>
            new ReactionSyncAbortedError({
                resetAt: new Date('2026-08-20T00:01:00.000Z'),
                message: 'Reaction sync aborted after 3 rate-limited PRs',
                partialReactions,
                context: { organizationId: 'org-001', teamId: 'team-001' },
            });

        it('should persist what was collected before rethrowing', async () => {
            const partial = collectedReaction();
            getReactionsUseCase.execute.mockRejectedValue(
                abortedError([partial]),
            );

            await expect(useCase.execute(payload)).rejects.toBeInstanceOf(
                ReactionSyncAbortedError,
            );

            expect(
                codeReviewFeedbackService.bulkUpsertReactions,
            ).toHaveBeenCalledWith([partial]);
        });

        it('should still rethrow when there was nothing to persist', async () => {
            getReactionsUseCase.execute.mockRejectedValue(abortedError([]));

            await expect(useCase.execute(payload)).rejects.toBeInstanceOf(
                ReactionSyncAbortedError,
            );

            expect(
                codeReviewFeedbackService.bulkUpsertReactions,
            ).not.toHaveBeenCalled();
        });

        it('should keep the abort classification when persisting the partials fails', async () => {
            getReactionsUseCase.execute.mockRejectedValue(
                abortedError([collectedReaction()]),
            );
            codeReviewFeedbackService.bulkUpsertReactions.mockRejectedValue(
                new Error('Database write failed'),
            );

            const error = await useCase.execute(payload).catch((e) => e);

            // The DB failure must not downgrade the reschedule to the generic
            // backoff curve — that would retry into an exhausted bucket
            expect(error).toBeInstanceOf(ReactionSyncAbortedError);
            expect(isRateLimitError(error)).toBe(true);
        });

        it('should keep the rate-limit classification so the consumer reschedules', async () => {
            getReactionsUseCase.execute.mockRejectedValue(
                abortedError([collectedReaction()]),
            );

            const error = await useCase.execute(payload).catch((e) => e);

            expect(isRateLimitError(error)).toBe(true);
            expect(error.resetAt).toEqual(new Date('2026-08-20T00:01:00.000Z'));
        });
    });
});
