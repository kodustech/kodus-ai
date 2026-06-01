import {
    IWebhookBitbucketDataCenterPullRequestEvent,
    IWebhookBitbucketPullRequestEvent,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-bitbucket.type';
import {
    IMappedComment,
    IMappedPlatform,
    IMappedPullRequest,
    IMappedRepository,
    IMappedUsers,
    MappedAction,
} from '@libs/platform/domain/platformIntegrations/types/webhooks/webhooks-common.type';

import { extractRepoFullName } from './webhooks.utils';

export class BitbucketMappedPlatform implements IMappedPlatform {
    mapUsers(params: {
        payload:
            | IWebhookBitbucketPullRequestEvent
            | IWebhookBitbucketDataCenterPullRequestEvent;
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
        payload:
            | IWebhookBitbucketPullRequestEvent
            | IWebhookBitbucketDataCenterPullRequestEvent;
    }): IMappedPullRequest {
        if (
            !params?.payload?.pullrequest ||
            params.payload?.isDataCenterEvent === undefined
        ) {
            return null;
        }

        const { payload } = params;

        let data = {
            ...payload?.pullrequest,
            number: payload?.pullrequest?.id,
            user: payload?.pullrequest?.author,
            title: payload?.pullrequest?.title,
            body: payload?.pullrequest?.description,
            isDraft: payload?.pullrequest?.draft ?? false,
            tags: [],
        } as Partial<IMappedPullRequest>;

        if (payload?.isDataCenterEvent === true) {
            data = {
                ...data,
                repository: payload?.pullrequest?.toRef?.repository,
                url: '',
                head: {
                    repo: {
                        fullName:
                            payload?.pullrequest?.fromRef?.repository?.name,
                    },
                    ref: payload?.pullrequest?.fromRef?.displayId,
                },
                base: {
                    repo: {
                        fullName: payload?.pullrequest?.toRef?.repository?.name,
                        defaultBranch: 'master',
                    },
                    ref: payload?.pullrequest?.toRef?.displayId,
                },
            };
        } else {
            data = {
                ...data,
                repository: payload?.repository,
                url: payload?.pullrequest?.links?.html?.href,
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

        return data as IMappedPullRequest;
    }

    mapRepository(params: {
        payload:
            | IWebhookBitbucketPullRequestEvent
            | IWebhookBitbucketDataCenterPullRequestEvent;
    }): IMappedRepository {
        if (params?.payload?.isDataCenterEvent === undefined) {
            return null;
        }

        if (params.payload?.isDataCenterEvent === true) {
            if (!params?.payload?.pullrequest?.toRef?.repository) {
                return null;
            }

            const repository = params.payload.pullrequest.toRef.repository;

            return {
                ...repository,
                id: repository.id.toString(),
                name: repository.name,
                language: null,
                fullName: repository.name,
                url: '',
            };
        } else {
            if (!params?.payload?.repository) {
                return null;
            }

            const repository = params.payload.repository;

            return {
                ...repository,
                id: repository.uuid,
                name: repository.name,
                language: null,
                fullName:
                    extractRepoFullName(params.payload?.pullrequest) ??
                    repository.name ??
                    '',
                url: repository?.links?.html?.href || '',
            };
        }
    }

    mapComment(params: {
        payload:
            | IWebhookBitbucketPullRequestEvent
            | IWebhookBitbucketDataCenterPullRequestEvent;
    }): IMappedComment {
        if (!params?.payload?.comment) {
            return null;
        }

        const body =
            params?.payload?.isDataCenterEvent === true
                ? params?.payload?.comment?.text
                : params?.payload?.comment?.content?.raw;

        return {
            id: params?.payload?.comment?.id.toString(),
            body,
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
            case 'pr:opened':
                return MappedAction.OPENED;
            case 'pullrequest:updated':
            case 'pr:modified':
                return MappedAction.UPDATED;
            default:
                return params?.event;
        }
    }
}
