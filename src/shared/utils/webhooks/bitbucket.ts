import { IWebhookBitbucketPullRequestEvent } from '@/core/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';
import {
    IMappedComment,
    IMappedPlatform,
    IMappedPullRequest,
    IMappedRepository,
    IMappedUsers,
    MappedAction,
} from '@/core/domain/platformIntegrations/types/webhooks/webhooks-common.type';

export class BitbucketMappedPlatform implements IMappedPlatform {
    mapUsers(params: {
        payload: IWebhookBitbucketPullRequestEvent;
    }): IMappedUsers {
        if (!params?.payload?.pullrequest) {
            return null;
        }

        const { payload } = params;

        return {
            user: payload?.pullrequest?.author,
            assignees: payload?.pullrequest?.participants,
            reviewers: payload?.pullrequest?.reviewers,
        };
    }

    mapPullRequest(params: {
        payload: IWebhookBitbucketPullRequestEvent;
    }): IMappedPullRequest {
        if (!params?.payload?.pullrequest) {
            return null;
        }

        const { payload } = params;

        return {
            ...payload?.pullrequest,
            repository: payload?.repository,
            number: payload?.pullrequest?.id,
            user: payload?.actor,
            title: payload?.pullrequest?.title,
            body: payload?.pullrequest?.description,
            head: {
                repo: {
                    fullName:
                        payload?.pullrequest?.source?.repository?.full_name,
                },
                ref: payload?.pullrequest?.source?.branch?.name,
            },
            base: {
                repo: {
                    fullName:
                        payload?.pullrequest?.destination?.repository
                            ?.full_name,
                    defaultBranch:
                        payload?.pullrequest?.destination?.branch?.name,
                },
                ref: payload?.pullrequest?.destination?.branch?.name,
            },
        };
    }

    mapRepository(params: {
        payload: IWebhookBitbucketPullRequestEvent;
    }): IMappedRepository {
        if (!params?.payload?.repository) {
            return null;
        }

        const repository = params.payload?.pullrequest?.destination?.repository;

        return {
            ...repository,
            id: repository?.uuid,
            name: repository?.name,
            language: null,
        };
    }

    mapComment(params: {
        payload: IWebhookBitbucketPullRequestEvent;
    }): IMappedComment {
        if (!params?.payload?.comment) {
            return null;
        }

        return {
            id: params?.payload?.comment?.id.toString(),
            body: params?.payload?.comment?.content?.raw,
        };
    }

    mapAction(params: {
        payload: string;
        event?: string;
    }): MappedAction | string | null {
        if (!params?.event) {
            return null;
        }

        switch (params?.event) {
            case 'pullrequest:created':
                return MappedAction.OPENED;
            case 'pullrequest:updated':
                return MappedAction.UPDATED;
            default:
                return params?.event;
        }
    }
}
