import { Entity } from '@/shared/domain/interfaces/entity';
import { ISuggestionEmbedded } from '../interfaces/suggestionEmbedded.interface';
import { IOrganization } from '@/core/domain/organization/interfaces/organization.interface';

export class SuggestionEmbeddedEntity implements Entity<ISuggestionEmbedded> {
    private _uuid: string;
    private _suggestionId: string;
    private _suggestionEmbed: number[];
    private _pullRequestNumber: number;
    private _repositoryId: string;
    private _repositoryFullName: string;
    private _organization?: Partial<IOrganization>;
    private _label: string;
    private _severity: string;
    private _feedbackType: string;
    private _improvedCode: string;
    private _suggestionContent: string;
    private _language: string;

    private constructor(embedding: ISuggestionEmbedded) {
        this._uuid = embedding.uuid;
        this._suggestionId = embedding.suggestionId;
        this._suggestionEmbed = embedding.suggestionEmbed;
        this._pullRequestNumber = embedding.pullRequestNumber;
        this._repositoryId = embedding.repositoryId;
        this._repositoryFullName = embedding.repositoryFullName;
        this._organization = embedding.organization;
        this._label = embedding.label;
        this._severity = embedding.severity;
        this._feedbackType = embedding.feedbackType;
        this._improvedCode = embedding.improvedCode;
        this._suggestionContent = embedding.suggestionContent;
        this._language = embedding.language;
    }

    public static create(
        embedding: ISuggestionEmbedded,
    ): SuggestionEmbeddedEntity {
        return new SuggestionEmbeddedEntity(embedding);
    }

    public toObject(): ISuggestionEmbedded {
        return {
            uuid: this._uuid,
            suggestionId: this._suggestionId,
            suggestionEmbed: this._suggestionEmbed,
            pullRequestNumber: this._pullRequestNumber,
            repositoryId: this._repositoryId,
            repositoryFullName: this._repositoryFullName,
            organization: this._organization,
            label: this._label,
            severity: this._severity,
            feedbackType: this._feedbackType,
            improvedCode: this._improvedCode,
            suggestionContent: this._suggestionContent,
            language: this._language,
        };
    }

    public toJson(): Partial<ISuggestionEmbedded> {
        return {
            uuid: this._uuid,
            suggestionId: this._suggestionId,
            suggestionEmbed: this._suggestionEmbed,
            pullRequestNumber: this._pullRequestNumber,
            repositoryId: this._repositoryId,
            repositoryFullName: this._repositoryFullName,
            organization: this._organization,
            label: this._label,
            severity: this._severity,
            feedbackType: this._feedbackType,
            improvedCode: this._improvedCode,
            suggestionContent: this._suggestionContent,
            language: this._language,
        };
    }

    // Getters
    public get uuid() {
        return this._uuid;
    }
    public get suggestionId() {
        return this._suggestionId;
    }
    public get suggestionEmbed() {
        return this._suggestionEmbed;
    }
    public get pullRequestNumber() {
        return this._pullRequestNumber;
    }
    public get repositoryId() {
        return this._repositoryId;
    }
    public get repositoryFullName() {
        return this._repositoryFullName;
    }
    public get organization() {
        return this._organization;
    }
    public get label() {
        return this._label;
    }
    public get severity() {
        return this._severity;
    }
    public get feedbackType() {
        return this._feedbackType;
    }
    public get improvedCode() {
        return this._improvedCode;
    }
    public get suggestionContent() {
        return this._suggestionContent;
    }
    public get language() {
        return this._language;
    }
}
