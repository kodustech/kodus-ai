import { CodeReviewFeedbackService } from '../codeReviewFeedback.service';
import { ICodeReviewFeedbackRepository } from '@libs/code-review/domain/codeReviewFeedback/contracts/codeReviewFeedback.repository';
import { CodeReviewFeedbackEntity } from '@libs/code-review/domain/codeReviewFeedback/entities/codeReviewFeedback.entity';

describe('CodeReviewFeedbackService', () => {
    let service: CodeReviewFeedbackService;
    let repository: jest.Mocked<ICodeReviewFeedbackRepository>;

    beforeEach(() => {
        repository = {
            bulkCreate: jest.fn(),
            bulkUpsertReactions: jest.fn(),
            findById: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            getNativeCollection: jest.fn(),
            findByOrganizationAndSyncedFlag: jest.fn(),
            updateSyncedSuggestionsFlag: jest.fn(),
        };

        service = new CodeReviewFeedbackService(repository);
    });

    describe('bulkCreate', () => {
        it('should delegate to repository', async () => {
            const feedbacks = [
                {
                    organizationId: 'org-001',
                    reactions: { thumbsUp: 1, thumbsDown: 0 },
                    comment: { id: 100 },
                    suggestionId: 'sug-001',
                    pullRequest: {
                        id: 'pr-001',
                        number: 42,
                        repository: { id: 'repo-001', fullName: 'org/repo' },
                    },
                    syncedEmbeddedSuggestions: false,
                },
            ];

            const entities = feedbacks.map((f) =>
                CodeReviewFeedbackEntity.create({ ...f, uuid: 'uuid-1' }),
            );
            repository.bulkCreate.mockResolvedValue(entities);

            const result = await service.bulkCreate(feedbacks);

            expect(repository.bulkCreate).toHaveBeenCalledWith(feedbacks);
            expect(result).toEqual(entities);
        });
    });

    describe('getByOrganizationId', () => {
        it('should call find with organizationId filter', async () => {
            repository.find.mockResolvedValue([]);

            await service.getByOrganizationId('org-001');

            expect(repository.find).toHaveBeenCalledWith({
                organizationId: 'org-001',
            });
        });
    });

    describe('findByOrganizationAndSyncedFlag', () => {
        it('should delegate with all 3 params', async () => {
            repository.findByOrganizationAndSyncedFlag.mockResolvedValue([]);

            await service.findByOrganizationAndSyncedFlag(
                'org-001',
                'repo-001',
                false,
            );

            expect(
                repository.findByOrganizationAndSyncedFlag,
            ).toHaveBeenCalledWith('org-001', 'repo-001', false);
        });
    });

    describe('updateSyncedSuggestionsFlag', () => {
        it('should delegate to repository', async () => {
            repository.updateSyncedSuggestionsFlag.mockResolvedValue(undefined);

            await service.updateSyncedSuggestionsFlag(
                'org-001',
                ['sug-001', 'sug-002'],
                true,
            );

            expect(repository.updateSyncedSuggestionsFlag).toHaveBeenCalledWith(
                'org-001',
                ['sug-001', 'sug-002'],
                true,
            );
        });
    });
});
