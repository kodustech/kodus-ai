import type {
    ContextRequirement,
    ContextRevisionActor,
    ContextRevisionScope,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';

export interface IContextReference {
    uuid: string;
    parentReferenceId?: string;
    scope: ContextRevisionScope;
    entityType: string;
    entityId: string;
    requirements?: ContextRequirement[];
    knowledgeRefs?: Array<{ itemId: string; version?: string }>;
    revisionId?: string;
    origin?: ContextRevisionActor;
    processingStatus?: 'pending' | 'processing' | 'completed' | 'failed';
    lastProcessedAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
    metadata?: Record<string, unknown>;
}
