import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IPullRequestWithDeliveredSuggestions } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { ICodeReviewFeedback } from '@libs/code-review/domain/codeReviewFeedback/interfaces/codeReviewFeedback.interface';
import { CodeReviewFeedbackEntity } from '@libs/code-review/domain/codeReviewFeedback/entities/codeReviewFeedback.entity';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';

export function createSampleOrganizationAndTeamData(
    overrides?: Partial<OrganizationAndTeamData>,
): OrganizationAndTeamData {
    return {
        organizationId: 'org-uuid-001',
        teamId: 'team-uuid-001',
        ...overrides,
    };
}

export function createSamplePullRequestWithSuggestions(
    overrides?: Partial<IPullRequestWithDeliveredSuggestions>,
): IPullRequestWithDeliveredSuggestions {
    return {
        _id: 'pr-id-001',
        number: 42,
        organizationId: 'org-uuid-001',
        status: 'MERGED',
        provider: 'GITHUB',
        repository: {
            id: 'repo-id-001',
            name: 'my-repo',
        },
        suggestions: [
            {
                id: 'suggestion-001',
                deliveryStatus: DeliveryStatus.SENT,
                comment: {
                    id: 100,
                    pullRequestReviewId: 200,
                },
            },
            {
                id: 'suggestion-002',
                deliveryStatus: DeliveryStatus.SENT,
                comment: {
                    id: 101,
                    pullRequestReviewId: 200,
                },
            },
        ],
        ...overrides,
    };
}

export function createSampleComment(
    overrides?: Partial<{
        id: number;
        threadId?: number;
        notes?: { id: number }[];
        reactions: { thumbsUp: number; thumbsDown: number };
    }>,
) {
    return {
        id: 100,
        reactions: { thumbsUp: 0, thumbsDown: 0 },
        ...overrides,
    };
}

export function createSampleReactionResult(
    overrides?: Partial<{
        reactions: { thumbsUp: number; thumbsDown: number };
        comment: { id: number; pull_request_review_id?: string };
        pullRequest: {
            id: string;
            number: number;
            repository?: { id: string; fullName: string };
        };
    }>,
) {
    return {
        reactions: { thumbsUp: 1, thumbsDown: 0 },
        comment: { id: 100, pull_request_review_id: 'pr-review-200' },
        pullRequest: {
            id: 'pr-id-001',
            number: 42,
            repository: { id: 'repo-id-001', fullName: 'org/my-repo' },
        },
        ...overrides,
    };
}

export function createSampleFeedbackEntity(
    overrides?: Partial<ICodeReviewFeedback>,
): CodeReviewFeedbackEntity {
    return CodeReviewFeedbackEntity.create({
        uuid: 'feedback-uuid-001',
        organizationId: 'org-uuid-001',
        reactions: { thumbsUp: 1, thumbsDown: 0 },
        comment: { id: 100, pullRequestReviewId: 'pr-review-200' },
        suggestionId: 'suggestion-001',
        pullRequest: {
            id: 'pr-id-001',
            number: 42,
            repository: { id: 'repo-id-001', fullName: 'org/my-repo' },
        },
        syncedEmbeddedSuggestions: false,
        ...overrides,
    });
}
