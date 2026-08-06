import { Column, Entity, Index } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import {
    ContextRequirement,
    ContextRevisionActor,
    ContextRevisionScope,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';

@Entity('context_references')
// Covers ContextReferenceRepository.applyFilter's most common lookup
// (`find({ entityType, entityId })`) — the table had zero indexes and
// was doing a Seq Scan for every one of the ~2.5M queries/day this
// path emits. Added after the 2026-08-06 pool-exhaustion incident.
@Index('IDX_context_references_entity', ['entityType', 'entityId'], {
    concurrent: true,
})
// Partial: covers `find({ parentReferenceId })` while skipping the
// many-null rows a full-column btree would waste space on. TypeORM
// cannot emit the WHERE clause here, so `synchronize: false` and the
// real CREATE lives in the migration (see CronPoolReliefIndexes2026080600000000).
@Index('IDX_context_references_parent', { synchronize: false })
export class ContextReferenceModel extends CoreModel {
    @Column({ type: 'varchar', length: 64, nullable: true })
    parentReferenceId?: string;

    @Column({ type: 'jsonb' })
    scope: ContextRevisionScope;

    @Column({ type: 'varchar', length: 128 })
    entityType: string;

    @Column({ type: 'varchar', length: 256 })
    entityId: string;

    @Column({ type: 'jsonb', nullable: true })
    requirements?: ContextRequirement[];

    @Column({ type: 'jsonb', nullable: true })
    knowledgeRefs?: Array<{ itemId: string; version?: string }>;

    @Column({ type: 'varchar', length: 256, nullable: true })
    revisionId?: string;

    @Column({ type: 'jsonb', nullable: true })
    origin?: ContextRevisionActor;

    @Column({
        type: 'enum',
        enum: ['pending', 'processing', 'completed', 'failed'],
        nullable: true,
    })
    processingStatus?: 'pending' | 'processing' | 'completed' | 'failed';

    @Column({ type: 'timestamp', nullable: true })
    lastProcessedAt?: Date;

    @Column({ type: 'jsonb', nullable: true })
    metadata?: Record<string, unknown>;
}
