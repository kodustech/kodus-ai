import {
    IMappedComment,
    IMappedPlatform,
    IMappedPullRequest,
    IMappedRepository,
    IMappedUsers,
    MappedAction,
} from '@/core/domain/platformIntegrations/types/webhooks/webhooks-common.type';
import {
    IWebhookGitlabMergeRequestEvent,
    IWebhookGitlabCommentEvent,
} from '@/core/domain/platformIntegrations/types/webhooks/webhooks-gitlab.type';

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
            !('merge_request' in params?.payload)
        ) {
            return null;
        }

        const { payload } = params;

        let mergeRequest = this.isGitlabCommentEvent(payload)
            ? payload.merge_request
            : payload.object_attributes;

        return {
            ...mergeRequest,
            repository: payload?.repository,
            number: mergeRequest?.iid,
            user: payload?.user,
            body: mergeRequest?.description,
            title: mergeRequest?.title,
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
        };
    }

    mapRepository(params: {
        payload: IWebhookGitlabMergeRequestEvent;
    }): IMappedRepository {
        if (!params?.payload?.repository) {
            return null;
        }

        const project = params?.payload?.project;

        return {
            ...project,
            id: project?.id?.toString(),
            name: project?.name,
            language: null,
        };
    }

    mapComment(params: {
        payload: IWebhookGitlabCommentEvent;
    }): IMappedComment {
        if (!params?.payload?.object_attributes?.note) {
            return null;
        }

        return {
            id: params?.payload?.object_attributes?.noteable_id.toString(),
            body: params?.payload?.object_attributes?.note,
        };
    }

    mapAction(params: {
        payload: IWebhookGitlabMergeRequestEvent;
    }): MappedAction | string | null {
        if (!params?.payload?.object_attributes) {
            return null;
        }

        switch (params?.payload?.object_attributes?.action) {
            case 'open':
                return MappedAction.OPENED;
            case 'update':
                return MappedAction.UPDATED;
            default:
                return params?.payload?.object_attributes?.action;
        }
    }
}
