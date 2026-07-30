import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOptionsWhere, In } from 'typeorm';
import { ContextReferenceModel } from './schemas/contextReference.model';
import { ContextReferenceEntity } from '@libs/ai-engine/domain/contextReference/entities/context-reference.entity';
import { IContextReference } from '@libs/ai-engine/domain/contextReference/interfaces/context-reference.interface';
import { IContextReferenceRepository } from '@libs/ai-engine/domain/contextReference/contracts/context-reference.repository.contract';
import { createLogger } from '@libs/core/log/logger';

function modelToEntity(model: ContextReferenceModel): ContextReferenceEntity {
    return ContextReferenceEntity.create({
        uuid: model.uuid,
        parentReferenceId: model.parentReferenceId ?? undefined,
        scope: model.scope,
        entityType: model.entityType,
        entityId: model.entityId,
        requirements: model.requirements ?? undefined,
        knowledgeRefs: model.knowledgeRefs ?? undefined,
        revisionId: model.revisionId ?? undefined,
        origin: model.origin ?? undefined,
        processingStatus: model.processingStatus ?? undefined,
        lastProcessedAt: model.lastProcessedAt ?? undefined,
        createdAt: model.createdAt,
        updatedAt: model.updatedAt,
        metadata: model.metadata ?? undefined,
    });
}

function applyFilter(
    filter: Partial<IContextReference>,
): FindOptionsWhere<ContextReferenceModel> {
    const where: FindOptionsWhere<ContextReferenceModel> = {};

    if (filter.uuid) {
        where.uuid = filter.uuid;
    }

    if (filter.parentReferenceId) {
        where.parentReferenceId = filter.parentReferenceId;
    }

    if (filter.scope) {
        where.scope = filter.scope as ContextReferenceModel['scope'];
    }

    if (filter.entityType) {
        where.entityType = filter.entityType;
    }

    if (filter.entityId) {
        where.entityId = filter.entityId;
    }

    return where;
}

@Injectable()
export class ContextReferenceRepository implements IContextReferenceRepository {
    private readonly logger = createLogger(ContextReferenceRepository.name);

    constructor(
        @InjectRepository(ContextReferenceModel)
        private readonly repository: Repository<ContextReferenceModel>,
    ) {}

    async create(
        contextReference: IContextReference,
    ): Promise<ContextReferenceEntity | undefined> {
        try {
            const model = this.repository.create({
                uuid: contextReference.uuid,
                parentReferenceId: contextReference.parentReferenceId,
                scope: contextReference.scope,
                entityType: contextReference.entityType,
                entityId: contextReference.entityId,
                requirements: contextReference.requirements,
                knowledgeRefs: contextReference.knowledgeRefs,
                revisionId: contextReference.revisionId,
                origin: contextReference.origin,
                processingStatus: contextReference.processingStatus,
                lastProcessedAt: contextReference.lastProcessedAt,
                metadata: contextReference.metadata,
            });

            const saved = await this.repository.save(model);
            return modelToEntity(saved);
        } catch (error) {
            this.logger.error({
                message: 'Failed to create context reference',
                context: ContextReferenceRepository.name,
                error,
                metadata: {
                    entityType: contextReference.entityType,
                    entityId: contextReference.entityId,
                },
            });
            throw error;
        }
    }

    async find(
        filter?: Partial<IContextReference>,
    ): Promise<ContextReferenceEntity[]> {
        const where = filter ? applyFilter(filter) : {};
        const results = await this.repository.find({
            where,
            order: { createdAt: 'DESC' },
        });
        return results.map(modelToEntity);
    }

    async findOne(
        filter: Partial<IContextReference>,
    ): Promise<ContextReferenceEntity | undefined> {
        const where = applyFilter(filter);
        const result = await this.repository.findOne({ where });
        return result ? modelToEntity(result) : undefined;
    }

    async findById(uuid: string): Promise<ContextReferenceEntity | undefined> {
        const result = await this.repository.findOne({
            where: { uuid },
        });
        return result ? modelToEntity(result) : undefined;
    }

    async findByIds(uuids: string[]): Promise<ContextReferenceEntity[]> {
        if (!uuids?.length) {
            return [];
        }
        const results = await this.repository.find({
            where: { uuid: In(uuids) },
        });
        return results.map(modelToEntity);
    }

    async update(
        filter: Partial<IContextReference>,
        data: Partial<IContextReference>,
    ): Promise<ContextReferenceEntity | undefined> {
        const where = applyFilter(filter);
        await this.repository.update(where, data as ContextReferenceModel);
        return this.findOne(filter);
    }

    async delete(uuid: string): Promise<void> {
        await this.repository.delete({ uuid });
    }
}
