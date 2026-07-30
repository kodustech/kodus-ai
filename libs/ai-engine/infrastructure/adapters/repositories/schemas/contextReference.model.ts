import { Column, Entity } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import {
    ContextRequirement,
    ContextRevisionActor,
    ContextRevisionScope,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';

@Entity('context_references')
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
