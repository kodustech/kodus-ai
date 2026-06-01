import {
    IMappedComment,
    IMappedPlatform,
    IMappedPullRequest,
    IMappedRepository,
    IMappedUsers,
    MappedAction,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-common.type';
import {
    IWebhookGitlabMergeRequestEvent,
    IWebhookGitlabCommentEvent,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-gitlab.type';

import { extractRepoFullName } from './webhooks.utils';

export class GitlabMappedPlatform implements IMappedPlatform {
    mapUsers(params: {
        payload: IWebhookGitlabMergeRequestEvent;
    }): IMappedUsers {
        if (!params?.payload?.user) {
            return null;
        }

        const { payload } = params;

        return {
            user: payload?.user,
            assignees: payload?.assignees,
            reviewers: payload?.reviewers,
        };
    }

    private isGitlabCommentEvent(
        payload: any,
    ): payload is IWebhookGitlabCommentEvent {
        return payload?.event_type === 'note';
    }

    mapPullRequest(params: {
        payload: IWebhookGitlabMergeRequestEvent | IWebhookGitlabCommentEvent;
    }): IMappedPullRequest {
        if (
            !params?.payload?.object_attributes &&
            (!params?.payload || !('merge_request' in params.payload))
        ) {
            return null;
        }

        const { payload } = params;

        const mergeRequest = this.isGitlabCommentEvent(payload)
            ? payload.merge_request
            : payload.object_attributes;

        return {
            ...mergeRequest,
            repository: payload?.repository,
            number: mergeRequest?.iid,
            user: payload?.user,
            body: mergeRequest?.description,
            title: mergeRequest?.title,
            url: (mergeRequest as any)?.url,
            head: {
                repo: {
                    fullName: mergeRequest?.source?.path_with_namespace,
                },
                ref: mergeRequest?.source_branch,
            },
            base: {
                repo: {
                    fullName: mergeRequest?.target?.path_with_namespace,
                    defaultBranch: mergeRequest?.target?.default_branch,
                },
                ref: mergeRequest?.target_branch,
            },
            isDraft:
                'draft' in mergeRequest
                    ? (mergeRequest?.draft ?? false)
                    : false,
            tags: mergeRequest?.labels?.map((label) => label.title) ?? [],
        };
    }

    mapRepository(params: {
        payload: IWebhookGitlabMergeRequestEvent | IWebhookGitlabCommentEvent;
    }): IMappedRepository {
        if (!params?.payload?.repository) {
            return null;
        }

        const { payload } = params;

        const mergeRequest = this.isGitlabCommentEvent(payload)
            ? payload.merge_request
            : payload.object_attributes;

        const project = params?.payload?.project;

        return {
            ...project,
            id: project?.id?.toString(),
            name: project?.name,
            language: null,
            fullName: extractRepoFullName(mergeRequest) ?? project?.name ?? '',
            url: project?.web_url || project?.url,
        };
    }

    mapComment(params: {
        payload: IWebhookGitlabCommentEvent;
    }): IMappedComment {
        if (!params?.payload?.object_attributes?.note) {
            return null;
        }

        return {
            id: params?.payload?.object_attributes?.id.toString(),
            body: params?.payload?.object_attributes?.note,
        };
    }

    mapAction(params: {
        payload: IWebhookGitlabMergeRequestEvent;
    }): MappedAction | string | null {
        if (!params?.payload?.object_attributes) {
            return null;
        }

        const action =
            params?.payload?.object_attributes?.action ??
            params?.payload?.action ??
            params?.payload?.event_type;

        switch (action) {
            case 'open':
                return MappedAction.OPENED;
            case 'update':
                return MappedAction.UPDATED;
            default:
                return action;
        }
    }
}
