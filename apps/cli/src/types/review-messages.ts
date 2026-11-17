import type { CentralizedPrMetadata } from './config.js';
import type { FormattedConfigLeaf } from './review-settings.js';

/** PullRequestMessageStatus in libs/core/.../pullRequestMessages.type.ts. */
export type PullRequestMessageStatus =
    'every_push' | 'only_when_opened' | 'off' | 'active' | 'inactive';

export type ReviewMessageType =
    'startReviewMessage' | 'endReviewMessage' | 'errorReviewMessage';

export type ReviewMessage = {
    content: string;
    status: PullRequestMessageStatus;
};

export type MessagesGlobalSettings = {
    hideComments: boolean;
    suggestionCopyPrompt: boolean;
};

export type FormattedReviewMessage = {
    content: FormattedConfigLeaf;
    status: FormattedConfigLeaf;
};

/** GET /pull-request-messages/find-by-repository-or-directory. */
export type FormattedPullRequestMessages = {
    uuid?: string;
    repositoryId?: string;
    directoryId?: string;
    startReviewMessage?: FormattedReviewMessage;
    endReviewMessage?: FormattedReviewMessage;
    errorReviewMessage?: FormattedReviewMessage;
    globalSettings?: {
        hideComments?: FormattedConfigLeaf;
        suggestionCopyPrompt?: FormattedConfigLeaf;
    };
};

/** POST /pull-request-messages (PullRequestMessagesUpsertDto). */
export type SavePullRequestMessagesRequest = {
    teamId: string;
    configLevel: 'global' | 'repository' | 'directory';
    repositoryId: string | null;
    directoryId?: string;
    startReviewMessage: ReviewMessage;
    endReviewMessage: ReviewMessage;
    errorReviewMessage: ReviewMessage;
    globalSettings: MessagesGlobalSettings;
};

export type SavePullRequestMessagesResult =
    | (CentralizedPrMetadata & { mode: 'centralized-pr' })
    | void
    | null
    | Record<string, unknown>;

/** A team parameter as /parameters/find-by-key returns it. */
export type TeamParameter<T> = {
    uuid?: string;
    configKey?: string;
    configValue?: T;
};
