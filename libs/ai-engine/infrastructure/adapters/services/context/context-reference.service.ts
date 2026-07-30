import {
    ContextRevisionScope,
    ContextRequirement,
    ContextRevisionActor,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import {
    createRevisionEntry,
    computeRequirementsHash,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import {
    CONTEXT_REFERENCE_REPOSITORY_TOKEN,
    IContextReferenceRepository,
} from '@libs/ai-engine/domain/contextReference/contracts/context-reference.repository.contract';
import { IContextReferenceService } from '@libs/ai-engine/domain/contextReference/contracts/context-reference.service.contract';
import { ContextReferenceEntity } from '@libs/ai-engine/domain/contextReference/entities/context-reference.entity';
import { IContextReference } from '@libs/ai-engine/domain/contextReference/interfaces/context-reference.interface';

@Injectable()
export class ContextReferenceService implements IContextReferenceService {
    constructor(
        @Inject(CONTEXT_REFERENCE_REPOSITORY_TOKEN)
        private readonly repository: IContextReferenceRepository,
    ) {}

    async commitRevision(params: {
        scope: ContextRevisionScope;
        entityType: string;
        entityId: string;
        requirements?: ContextRequirement[];
        parentReferenceId?: string;
        uuid?: string;
        origin?: ContextRevisionActor;
        metadata?: Record<string, unknown>;
        knowledgeRefs?: Array<{ itemId: string; version?: string }>;
        revisionId?: string;
    }): Promise<{
        revision: ContextReferenceEntity;
        pointer: { uuid: string; requirementsHash?: string };
    }> {
        const uuid = params.uuid ?? uuidv4();
        const origin: ContextRevisionActor = params.origin ?? {
            kind: 'system',
            id: 'unknown',
        };

        const scopeWithTenant = this.ensureTenantInScope(params.scope);
        const allRequirements = params.requirements ?? [];

        const entry = createRevisionEntry({
            revisionId: uuid,
            parentRevisionId: params.parentReferenceId,
            scope: scopeWithTenant,
            entityType: params.entityType,
            entityId: params.entityId,
            origin,
            requirements: allRequirements,
            metadata: params.metadata,
            knowledgeRefs: params.knowledgeRefs,
        });

        const metadataWithRevision = {
            ...(entry.metadata ?? {}),
            ...(params.revisionId && { revisionId: params.revisionId }),
        };

        const processingStatus = this.computeProcessingStatus(
            entry.requirements,
        );

        const contextReference: IContextReference = {
            uuid: entry.revisionId,
            parentReferenceId: entry.parentRevisionId,
            scope: entry.scope,
            entityType: entry.entityType,
            entityId: entry.entityId,
            requirements: entry.requirements,
            knowledgeRefs: entry.knowledgeRefs,
            origin: entry.origin,
            revisionId: params.revisionId,
            processingStatus,
            lastProcessedAt: new Date(),
            metadata: metadataWithRevision,
        };

        const persisted = await this.repository.create(contextReference);
        if (!persisted) {
            throw new Error('Failed to persist context reference');
        }

        const requirementsHash =
            entry.requirements && entry.requirements.length
                ? computeRequirementsHash(entry.requirements)
                : undefined;

        return {
            revision: persisted,
            pointer: { uuid: persisted.uuid, requirementsHash },
        };
    }

    async getRevisionHistory(
        entityType: string,
        entityId: string,
        limit?: number,
    ): Promise<ContextReferenceEntity[]> {
        const results = await this.repository.find({ entityType, entityId });
        if (typeof limit === 'number' && limit >= 0) {
            return results.slice(0, limit);
        }
        return results;
    }

    async getLatestRevision(
        entityType: string,
        entityId: string,
    ): Promise<ContextReferenceEntity | undefined> {
        const [latest] = await this.getRevisionHistory(entityType, entityId, 1);
        return latest;
    }

    async rollbackTo(params: {
        targetReferenceId: string;
        origin?: ContextRevisionActor;
    }): Promise<{
        revision: ContextReferenceEntity;
        pointer: { uuid: string; requirementsHash?: string };
    }> {
        const target = await this.repository.findById(params.targetReferenceId);

        if (!target) {
            throw new Error(
                `Context reference ${params.targetReferenceId} not found`,
            );
        }

        const latest = await this.getLatestRevision(
            target.entityType,
            target.entityId,
        );

        return this.commitRevision({
            scope: target.scope,
            entityType: target.entityType,
            entityId: target.entityId,
            requirements: target.requirements,
            parentReferenceId: latest?.uuid,
            origin:
                params.origin ??
                target.origin ??
                ({ kind: 'system', id: 'rollback' } as ContextRevisionActor),
            metadata: target.metadata,
            knowledgeRefs: target.knowledgeRefs,
        });
    }

    async create(
        contextReference: IContextReference,
    ): Promise<ContextReferenceEntity | undefined> {
        return this.repository.create(contextReference);
    }

    async find(
        filter?: Partial<IContextReference>,
    ): Promise<ContextReferenceEntity[]> {
        return this.repository.find(filter);
    }

    async findOne(
        filter: Partial<IContextReference>,
    ): Promise<ContextReferenceEntity | undefined> {
        return this.repository.findOne(filter);
    }

    async findById(uuid: string): Promise<ContextReferenceEntity | undefined> {
        return this.repository.findById(uuid);
    }

    async findByIds(uuids: string[]): Promise<ContextReferenceEntity[]> {
        return this.repository.findByIds(uuids);
    }

    async update(
        filter: Partial<IContextReference>,
        data: Partial<IContextReference>,
    ): Promise<ContextReferenceEntity | undefined> {
        return this.repository.update(filter, data);
    }

    async delete(uuid: string): Promise<void> {
        return this.repository.delete(uuid);
    }

    private ensureTenantInScope(
        scope: ContextRevisionScope,
    ): ContextRevisionScope {
        const identifiers = { ...scope.identifiers };

        if (identifiers.tenantId) {
            return { ...scope, identifiers };
        }

        if (identifiers.organizationId) {
            identifiers.tenantId = identifiers.organizationId;
        } else {
            console.warn(
                'ContextRevisionScope sem tenantId ou organizationId:',
                scope,
            );
        }

        return { ...scope, identifiers };
    }

    private computeProcessingStatus(
        requirements?: ContextRequirement[],
    ): 'pending' | 'processing' | 'completed' | 'failed' {
        if (!requirements || requirements.length === 0) {
            // An empty revision is a FINISHED state, not a queued one: it is
            // what a clean re-detection commits to clear stale errors. As
            // 'pending' the UI showed an eternal "Processing references…"
            // spinner on every rule whose references were cleaned up.
            return 'completed';
        }

        const hasErrors = requirements.some(
            (req) => (req.metadata as any)?.syncErrors?.length > 0,
        );
        const hasDraft = requirements.some((req) => req.status === 'draft');
        const allActive = requirements.every((req) => req.status === 'active');

        if (hasErrors) {
            return 'failed';
        }

        if (hasDraft) {
            return 'processing';
        }

        if (allActive) {
            return 'completed';
        }

        return 'pending';
    }
}
