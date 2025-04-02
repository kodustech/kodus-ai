import { Entity } from '@/shared/domain/interfaces/entity';
import { ICodeReviewFeedback } from '../interfaces/codeReviewFeedback.interface';

export class CodeReviewFeedbackEntity implements Entity<ICodeReviewFeedback> {
    private readonly _uuid: string;
    private readonly _organizationId: string;
    private readonly _reactions: {
        thumbsUp: number;
        thumbsDown: number;
    };
    private readonly _comment: {
        id: number;
        pullRequestReviewId?: string;
    };
    private readonly _suggestionId: string;

    private readonly _pullRequest: {
        id: string;
        number: number;
        repository: {
            id: string;
            fullName: string;
        };
    };

    private readonly _syncedEmbeddedSuggestions: boolean;

    constructor(feedback: ICodeReviewFeedback | Partial<ICodeReviewFeedback>) {
        this._uuid = feedback.uuid;
        this._organizationId = feedback.organizationId;
        this._reactions = feedback.reactions;
        this._comment = feedback.comment;
        this._suggestionId = feedback.suggestionId;
        this._pullRequest = feedback.pullRequest;
        this._syncedEmbeddedSuggestions = feedback.syncedEmbeddedSuggestions ?? false;
    }

    toJson(): ICodeReviewFeedback {
        return {
            uuid: this._uuid,
            organizationId: this._organizationId,
            reactions: this._reactions,
            comment: this._comment,
            suggestionId: this._suggestionId,
            pullRequest: this._pullRequest,
            syncedEmbeddedSuggestions: this._syncedEmbeddedSuggestions,
        };
    }

    toObject(): ICodeReviewFeedback {
        return {
            uuid: this._uuid,
            organizationId: this._organizationId,
            reactions: this._reactions,
            comment: this._comment,
            suggestionId: this._suggestionId,
            pullRequest: this._pullRequest,
            syncedEmbeddedSuggestions: this._syncedEmbeddedSuggestions,
        };
    }

    public static create(
        feedback: ICodeReviewFeedback | Partial<ICodeReviewFeedback>,
    ): CodeReviewFeedbackEntity {
        return new CodeReviewFeedbackEntity(feedback);
    }

    get uuid(): string {
        return this._uuid;
    }

    get organizationId(): string {
        return this._organizationId;
    }
    get reactions(): {
        thumbsUp: number;
        thumbsDown: number;
    } {
        return this._reactions;
    }
    get comment(): {
        id: number;
        pullRequestReviewId?: string;
    } {
        return this._comment;
    }
    get suggestionId(): string {
        return this._suggestionId;
    }
    get pullRequest(): {
        id: string;
        number: number;
        repository: {
            id: string;
            fullName: string;
        };
    } {
        return this._pullRequest;
    }
    get syncedEmbeddedSuggestions(): boolean {
        return this._syncedEmbeddedSuggestions;
    }
}
