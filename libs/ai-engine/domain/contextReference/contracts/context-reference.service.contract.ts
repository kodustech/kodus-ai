import type {
    ContextRequirement,
    ContextRevisionActor,
    ContextRevisionScope,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';

import { IContextReferenceRepository } from './context-reference.repository.contract';
import { ContextReferenceEntity } from '../entities/context-reference.entity';

export const CONTEXT_REFERENCE_SERVICE_TOKEN = Symbol(
    'ContextReferenceService',
);

/**
 * INVARIANTES DO SERVIÇO:
 * - Sempre garante tenantId em scope.identifiers (usa organizationId como fallback)
 * - Sempre mantém TODOS os requirements (incluindo draft/erro) para trilha completa de debugging
 * - Sempre mantém ponte com revisionId quando disponível
 * - Runtime filtra status 'active' para execução, mas preserva histórico completo
 * - Garante unicidade: no máximo 1 referência ativa por (tenantId, entityType, entityId, scope)
 */
export interface IContextReferenceService extends IContextReferenceRepository {
    commitRevision(params: {
        scope: ContextRevisionScope;
        entityType: string;
        entityId: string;
        requirements?: ContextRequirement[];
        parentReferenceId?: string;
        uuid?: string;
        origin?: ContextRevisionActor;
        metadata?: Record<string, unknown>;
        knowledgeRefs?: Array<{ itemId: string; version?: string }>;
        /** Ponte para o ContextRevisionLogEntry de origem */
        revisionId?: string;
    }): Promise<{
        revision: ContextReferenceEntity;
        pointer: {
            uuid: string;
            requirementsHash?: string;
        };
    }>;

    getRevisionHistory(
        entityType: string,
        entityId: string,
        limit?: number,
    ): Promise<ContextReferenceEntity[]>;

    getLatestRevision(
        entityType: string,
        entityId: string,
    ): Promise<ContextReferenceEntity | undefined>;

    rollbackTo(params: {
        targetReferenceId: string;
        origin?: ContextRevisionActor;
    }): Promise<{
        revision: ContextReferenceEntity;
        pointer: {
            uuid: string;
            requirementsHash?: string;
        };
    }>;
}
