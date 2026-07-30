import type {
    ContextRequirement,
    ContextRevisionActor,
    ContextRevisionScope,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';

import { Entity } from '@libs/core/domain/interfaces/entity';
import { IContextReference } from '../interfaces/context-reference.interface';

export class ContextReferenceEntity implements Entity<IContextReference> {
    private _uuid: string;
    private _parentReferenceId?: string;
    private _scope: ContextRevisionScope;
    private _entityType: string;
    private _entityId: string;
    private _requirements?: ContextRequirement[];
    private _knowledgeRefs?: Array<{ itemId: string; version?: string }>;
    private _revisionId?: string;
    private _origin?: ContextRevisionActor;
    private _processingStatus?:
        | 'pending'
        | 'processing'
        | 'completed'
        | 'failed';
    private _lastProcessedAt?: Date;
    private _createdAt?: Date;
    private _updatedAt?: Date;
    private _metadata?: Record<string, unknown>;

    private constructor(
        contextReference: IContextReference | Partial<IContextReference>,
    ) {
        this._uuid = contextReference.uuid;
        this._parentReferenceId = contextReference.parentReferenceId;
        this._scope = contextReference.scope;
        this._entityType = contextReference.entityType;
        this._entityId = contextReference.entityId;
        this._requirements = contextReference.requirements;
        this._knowledgeRefs = contextReference.knowledgeRefs;
        this._revisionId = contextReference.revisionId;
        this._origin = contextReference.origin;
        this._processingStatus = contextReference.processingStatus;
        this._lastProcessedAt = contextReference.lastProcessedAt;
        this._createdAt = contextReference.createdAt;
        this._updatedAt = contextReference.updatedAt;
        this._metadata = contextReference.metadata;
    }

    public static create(
        contextReference: IContextReference | Partial<IContextReference>,
    ): ContextReferenceEntity {
        return new ContextReferenceEntity(contextReference);
    }

    public get uuid() {
        return this._uuid;
    }

    public get parentReferenceId() {
        return this._parentReferenceId;
    }

    public get scope() {
        return this._scope;
    }

    public get entityType() {
        return this._entityType;
    }

    public get entityId() {
        return this._entityId;
    }

    public get requirements() {
        return this._requirements;
    }

    public get knowledgeRefs() {
        return this._knowledgeRefs;
    }

    public get origin() {
        return this._origin;
    }

    public get createdAt() {
        return this._createdAt;
    }

    public get updatedAt() {
        return this._updatedAt;
    }

    public get metadata() {
        return this._metadata;
    }

    public get revisionId() {
        return this._revisionId;
    }

    public get processingStatus() {
        return this._processingStatus;
    }

    public get lastProcessedAt() {
        return this._lastProcessedAt;
    }

    public toObject(): IContextReference {
        return {
            uuid: this._uuid,
            parentReferenceId: this._parentReferenceId,
            scope: this._scope,
            entityType: this._entityType,
            entityId: this._entityId,
            requirements: this._requirements,
            knowledgeRefs: this._knowledgeRefs,
            revisionId: this._revisionId,
            origin: this._origin,
            processingStatus: this._processingStatus,
            lastProcessedAt: this._lastProcessedAt,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
            metadata: this._metadata,
        };
    }

    public toJson(): Partial<IContextReference> {
        return {
            uuid: this._uuid,
            parentReferenceId: this._parentReferenceId,
            scope: this._scope,
            entityType: this._entityType,
            entityId: this._entityId,
            requirements: this._requirements,
            knowledgeRefs: this._knowledgeRefs,
            revisionId: this._revisionId,
            origin: this._origin,
            processingStatus: this._processingStatus,
            lastProcessedAt: this._lastProcessedAt,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
            metadata: this._metadata,
        };
    }
}
