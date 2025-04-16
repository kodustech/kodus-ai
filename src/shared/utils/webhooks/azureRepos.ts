import { AzureReposWebhookPayload } from '@/core/domain/platformIntegrations/types/webhooks/webhooks-azureRepos.type';
import {
    IMappedComment,
    IMappedPlatform,
    IMappedPullRequest,
    IMappedRepository,
    IMappedUsers,
    MappedAction,
} from '@/core/domain/platformIntegrations/types/webhooks/webhooks-common.type';

/**
 * Adapter for Azure Repos webhook payloads (pull request & comment events)
 * Maps AzureReposWebhookPayload to internal mapped types
 */
export class AzureReposMappedPlatform implements IMappedPlatform {
    mapUsers(params: { payload: AzureReposWebhookPayload }): IMappedUsers {
        const pullRequest = params?.payload?.resource?.pullRequest || params?.payload?.resource;

        if (!pullRequest || !pullRequest.createdBy) { return null };

        return {
            user: pullRequest.createdBy,
            assignees: [],
            reviewers: pullRequest.reviewers ?? [],
        };
    }

    mapPullRequest(params: { payload: AzureReposWebhookPayload }): IMappedPullRequest {
        const resource = params?.payload?.resource;
        const pullRequest = resource?.pullRequest || resource;

        if (!pullRequest || !pullRequest.pullRequestId) { return null };

        return {
            repository: pullRequest.repository,
            title: pullRequest.title ?? '',
            body: pullRequest.description ?? '',
            number: Number(pullRequest.pullRequestId),
            user: pullRequest.createdBy,
            head: {
                ref: pullRequest.sourceRefName ?? '',
                repo: {
                    fullName: pullRequest.repository?.name ?? '',
                },
            },
            base: {
                ref: pullRequest.targetRefName ?? '',
                repo: {
                    fullName: pullRequest.repository?.name ?? '',
                    defaultBranch: pullRequest.repository?.defaultBranch ?? '',
                },
            },
        };
    }

    mapRepository(params: { payload: AzureReposWebhookPayload }): IMappedRepository {
        const resource = params?.payload?.resource;
        const repo = resource?.pullRequest?.repository || resource?.repository;

        if (!repo) {
            return null;
        }

        return {
            ...repo,
            id: repo.id ? String(repo.id) : '',
            name: repo.name ?? '',
            language: null,
        };
    }

    mapComment(params: { payload: AzureReposWebhookPayload }): IMappedComment {
        const comment = params?.payload?.resource.comment;

        if (!comment) {
            return null;
        }

        return {
            id: String(comment.id ?? ''),
            body: comment.content ?? '',
        };
    }

    mapAction(params: { payload: AzureReposWebhookPayload }): MappedAction {
        return params?.payload?.eventType as MappedAction;
    }
}
