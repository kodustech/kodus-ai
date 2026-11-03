import {
    IMappedComment,
    IMappedPlatform,
    IMappedPullRequest,
    IMappedRepository,
    IMappedUsers,
    MappedAction,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-common.type';
import {
    IWebhookForgejoPullRequestEvent,
    IWebhookForgejoIssueCommentEvent,
    WebhookForgejoHookIssueAction,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-forgejo.type';

import { extractRepoFullName } from './webhooks.utils';

export class ForgejoMappedPlatform implements IMappedPlatform {
    mapUsers(params: {
        payload: IWebhookForgejoPullRequestEvent;
    }): IMappedUsers {
        if (!params?.payload?.pull_request) {
            return null;
        }

        const { payload } = params;

        return {
            user: payload?.pull_request.user,
            assignees: payload?.pull_request?.assignees,
            reviewers: payload?.pull_request?.requested_reviewers,
        };
    }

    mapPullRequest(params: {
        payload: IWebhookForgejoPullRequestEvent;
    }): IMappedPullRequest {
        if (!params?.payload?.pull_request) {
            return null;
        }

        const { payload } = params;

        const rawPullRequest = payload?.pull_request as any;
        const headRepoFullName =
            payload?.pull_request?.head?.repo?.full_name ||
            rawPullRequest?.head?.repo?.full_name ||
            '';
        const baseRepoFullName =
            payload?.pull_request?.base?.repo?.full_name ||
            rawPullRequest?.base?.repo?.full_name ||
            '';
        const headSha =
            payload?.pull_request?.head?.sha ??
            rawPullRequest?.head?.commit?.sha ??
            rawPullRequest?.headSha;

        return {
            ...payload?.pull_request,
            repository: payload?.repository,
            title: payload?.pull_request?.title,
            body: payload?.pull_request?.body,
            number: payload?.pull_request?.number,
            user: payload?.pull_request?.user,
            url:
                payload?.pull_request?.html_url ||
                rawPullRequest?.prURL ||
                payload?.pull_request?.url,
            head: {
                repo: {
                    fullName: headRepoFullName,
                },
                ref: payload?.pull_request?.head?.ref,
                sha: headSha,
            },
            base: {
                repo: {
                    fullName: baseRepoFullName,
                    defaultBranch: payload?.repository?.default_branch,
                },
                ref: payload?.pull_request?.base?.ref,
                sha: payload?.pull_request?.base?.sha,
            },
            isDraft: payload?.pull_request?.draft ?? false,
            tags:
                (payload as any)?.issue?.labels?.map(
                    (label: { name: string }) => label.name,
                ) ?? [],
        };
    }

    mapRepository(params: {
        payload: IWebhookForgejoPullRequestEvent;
    }): IMappedRepository {
        if (!params?.payload?.repository) {
            return null;
        }

        const repository = params.payload?.repository;
        const rawRepository = repository as any;

        const fullName =
            repository?.full_name ||
            rawRepository?.fullName ||
            extractRepoFullName(params?.payload?.pull_request as any) ||
            repository?.name ||
            '';

        return {
            ...repository,
            id: repository?.id.toString(),
            name: repository?.full_name,
            language: repository?.language,
            fullName,
            url: repository?.html_url || repository?.url,
        };
    }

    mapComment(params: {
        payload: IWebhookForgejoIssueCommentEvent;
    }): IMappedComment {
        if (!params?.payload?.comment) {
            return null;
        }

        return {
            id: params.payload?.comment?.id.toString(),
            body: params.payload?.comment?.body,
        };
    }

    mapAction(params: {
        payload: IWebhookForgejoPullRequestEvent;
    }): MappedAction | string | null {
        if (!params?.payload?.action) {
            return null;
        }

        switch (params?.payload?.action) {
            case WebhookForgejoHookIssueAction.OPENED:
                return MappedAction.OPENED;
            case WebhookForgejoHookIssueAction.SYNCHRONIZED:
                return MappedAction.UPDATED;
            default:
                return params?.payload?.action;
        }
    }
}
