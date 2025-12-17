import {
    ConfigLevel,
    PullRequestMessageStatus,
} from '@/config/types/general/pullRequestMessages.type';

export interface IPullRequestMessageContent {
    content: string;
    status: PullRequestMessageStatus;
}

export interface IPullRequestMessages {
    uuid?: string;
    organizationId: string;
    configLevel: ConfigLevel;
    repositoryId?: string;
    startReviewMessage?: IPullRequestMessageContent;
    endReviewMessage?: IPullRequestMessageContent;
    directoryId?: string;
    globalSettings?: {
        hideComments?: boolean;
        suggestionCopyPrompt?: boolean;
    };
}
