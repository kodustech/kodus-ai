import { SaveCodeReviewFeedbackUseCase } from '../save-feedback.use-case';
import { createSampleFeedbackEntity } from './fixtures';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
    }),
}));

describe('SaveCodeReviewFeedbackUseCase', () => {
    let useCase: SaveCodeReviewFeedbackUseCase;
    let codeReviewFeedbackService: {
        bulkCreate: jest.Mock;
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

    beforeEach(() => {
        codeReviewFeedbackService = {
            bulkCreate: jest.fn().mockResolvedValue([]),
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

    it('should fetch reactions and save new ones via bulkCreate', async () => {
        const reaction = {
            reactions: { thumbsUp: 1, thumbsDown: 0 },
            comment: { id: 100, pullRequestReviewId: 'pr-review-200' },
            suggestionId: 'suggestion-001',
            pullRequest: {
                id: 'pr-001',
                number: 42,
                repository: { id: 'repo-001', fullName: 'org/repo' },
            },
            organizationId: 'org-001',
        };
        getReactionsUseCase.execute.mockResolvedValue([reaction]);
        codeReviewFeedbackService.getByOrganizationId.mockResolvedValue([]);

        const savedEntity = createSampleFeedbackEntity();
        codeReviewFeedbackService.bulkCreate.mockResolvedValue([savedEntity]);

        const result = await useCase.execute(payload);

        expect(getReactionsUseCase.execute).toHaveBeenCalledWith(
            { organizationId: 'org-001', teamId: 'team-001' },
            [42],
        );
        expect(codeReviewFeedbackService.bulkCreate).toHaveBeenCalledWith([
            reaction,
        ]);
        expect(result).toEqual([savedEntity]);
    });

    it('should deduplicate by suggestionId (filter already existing)', async () => {
        const reaction1 = {
            reactions: { thumbsUp: 1, thumbsDown: 0 },
            comment: { id: 100 },
            suggestionId: 'suggestion-001',
            pullRequest: {
                id: 'pr-001',
                number: 42,
                repository: { id: 'repo-001', fullName: 'org/repo' },
            },
            organizationId: 'org-001',
        };
        const reaction2 = {
            ...reaction1,
            suggestionId: 'suggestion-002',
            comment: { id: 101 },
        };

        getReactionsUseCase.execute.mockResolvedValue([reaction1, reaction2]);

        // suggestion-001 already exists
        const existingFeedback = createSampleFeedbackEntity({
            suggestionId: 'suggestion-001',
        });
        codeReviewFeedbackService.getByOrganizationId.mockResolvedValue([
            existingFeedback,
        ]);

        codeReviewFeedbackService.bulkCreate.mockResolvedValue([
            createSampleFeedbackEntity({ suggestionId: 'suggestion-002' }),
        ]);

        await useCase.execute(payload);

        // Only suggestion-002 should be saved
        expect(codeReviewFeedbackService.bulkCreate).toHaveBeenCalledWith([
            reaction2,
        ]);
    });

    it('should return [] when all reactions already exist', async () => {
        const reaction = {
            reactions: { thumbsUp: 1, thumbsDown: 0 },
            comment: { id: 100 },
            suggestionId: 'suggestion-001',
            pullRequest: {
                id: 'pr-001',
                number: 42,
                repository: { id: 'repo-001', fullName: 'org/repo' },
            },
            organizationId: 'org-001',
        };
        getReactionsUseCase.execute.mockResolvedValue([reaction]);

        const existingFeedback = createSampleFeedbackEntity({
            suggestionId: 'suggestion-001',
        });
        codeReviewFeedbackService.getByOrganizationId.mockResolvedValue([
            existingFeedback,
        ]);

        const result = await useCase.execute(payload);

        expect(codeReviewFeedbackService.bulkCreate).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });

    it('should return [] when getReactions returns empty', async () => {
        getReactionsUseCase.execute.mockResolvedValue([]);

        const result = await useCase.execute(payload);

        expect(codeReviewFeedbackService.bulkCreate).not.toHaveBeenCalled();
        expect(result).toEqual([]);
    });

    it('should propagate errors from getReactionsUseCase', async () => {
        // BUG cascade: getReactionsUseCase.execute throws because
        // codeManagementService.countReactions throws "Repository service for type 'null' not found."
        // SaveCodeReviewFeedbackUseCase re-throws the error.
        getReactionsUseCase.execute.mockRejectedValue(
            new Error("Repository service for type 'null' not found."),
        );

        await expect(useCase.execute(payload)).rejects.toThrow(
            "Repository service for type 'null' not found.",
        );
    });

    it('should propagate errors from bulkCreate', async () => {
        const reaction = {
            reactions: { thumbsUp: 1, thumbsDown: 0 },
            comment: { id: 100 },
            suggestionId: 'suggestion-001',
            pullRequest: {
                id: 'pr-001',
                number: 42,
                repository: { id: 'repo-001', fullName: 'org/repo' },
            },
            organizationId: 'org-001',
        };
        getReactionsUseCase.execute.mockResolvedValue([reaction]);
        codeReviewFeedbackService.getByOrganizationId.mockResolvedValue([]);
        codeReviewFeedbackService.bulkCreate.mockRejectedValue(
            new Error('Database write failed'),
        );

        await expect(useCase.execute(payload)).rejects.toThrow(
            'Database write failed',
        );
    });
});
