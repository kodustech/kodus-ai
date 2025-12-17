import { Entity } from '@/shared/domain/interfaces/entity';
import {
    IPullRequestMessageContent,
    IPullRequestMessages,
} from '../interfaces/pullRequestMessages.interface';
import { ConfigLevel } from '@/config/types/general/pullRequestMessages.type';

export class PullRequestMessagesEntity implements Entity<IPullRequestMessages> {
    private readonly _uuid: string;
    private readonly _organizationId: string;
    private readonly _configLevel: ConfigLevel;
    private readonly _repositoryId?: string;
    private readonly _startReviewMessage?: IPullRequestMessageContent;
    private readonly _endReviewMessage?: IPullRequestMessageContent;
    private readonly _directoryId?: string;
    private readonly _globalSettings?: {
        hideComments?: boolean;
        suggestionCopyPrompt?: boolean;
    };
    private readonly _directoryPath?: string;

    constructor(pullRequestMessages: IPullRequestMessages) {
        this._uuid = pullRequestMessages.uuid;
        this._organizationId = pullRequestMessages.organizationId;
        this._configLevel = pullRequestMessages.configLevel;
        this._repositoryId = pullRequestMessages.repositoryId;
        this._startReviewMessage = pullRequestMessages.startReviewMessage;
        this._endReviewMessage = pullRequestMessages.endReviewMessage;
        this._directoryId = pullRequestMessages.directoryId;
        this._globalSettings = pullRequestMessages.globalSettings;
    }

    toJson(): IPullRequestMessages {
        return {
            uuid: this.uuid,
            organizationId: this.organizationId,
            configLevel: this.configLevel,
            repositoryId: this.repositoryId,
            startReviewMessage: this.startReviewMessage,
            endReviewMessage: this.endReviewMessage,
            directoryId: this.directoryId,
            globalSettings: this.globalSettings,
        };
    }

    toObject(): IPullRequestMessages {
        return this.toJson();
    }

    get uuid(): string {
        return this._uuid;
    }

    get organizationId(): string {
        return this._organizationId;
    }

    get configLevel(): ConfigLevel {
        return this._configLevel;
    }

    get repositoryId(): string | undefined {
        return this._repositoryId;
    }

    get startReviewMessage(): IPullRequestMessageContent | undefined {
        return this._startReviewMessage;
    }

    get endReviewMessage(): IPullRequestMessageContent | undefined {
        return this._endReviewMessage;
    }

    get directoryId(): string | undefined {
        return this._directoryId;
    }

    get globalSettings():
        | { hideComments?: boolean; suggestionCopyPrompt?: boolean }
        | undefined {
        return this._globalSettings;
    }

    public static create(
        pullRequestMessages: IPullRequestMessages,
    ): PullRequestMessagesEntity {
        return new PullRequestMessagesEntity(pullRequestMessages);
    }
}
