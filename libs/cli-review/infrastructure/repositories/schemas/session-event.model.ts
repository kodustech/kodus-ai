import { Column, Entity, Index } from 'typeorm';
import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { CliSessionClassifiedDecision } from '@libs/cli-review/domain/types/cli-session-capture.types';

export const SESSION_EVENT_TYPES = [
    'session_start',
    'turn_start',
    'turn_end',
    'subagent_start',
    'subagent_end',
    'session_end',
] as const;

export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

export type ClassificationStatus =
    | 'PROCESSING'
    | 'COMPLETED'
    | 'FAILED'
    | 'SKIPPED';

export type ClassificationSource =
    | 'llm'
    | 'heuristic'
    | 'heuristic-fallback'
    | 'empty';

@Entity('session_events')
@Index('IDX_session_events_org_session', ['organizationId', 'sessionId'])
@Index('IDX_session_events_org_branch', ['organizationId', 'branch'])
@Index('IDX_session_events_session_type', ['sessionId', 'type'])
@Index('IDX_session_events_timestamp', ['eventTimestamp'])
export class SessionEventModel extends CoreModel {
    @Column({ type: 'uuid', name: 'organization_id' })
    organizationId: string;

    @Column({ type: 'uuid', name: 'team_id' })
    teamId: string;

    @Column({ type: 'varchar', length: 120, name: 'session_id' })
    sessionId: string;

    @Column({ type: 'varchar', length: 30 })
    type: SessionEventType;

    @Column({ type: 'varchar', length: 250 })
    branch: string;

    @Column({ type: 'timestamp', name: 'event_timestamp' })
    eventTimestamp: Date;

    @Column({ type: 'jsonb' })
    payload: Record<string, unknown>;

    // Classification fields — only populated on session_end events
    @Column({
        type: 'varchar',
        length: 20,
        name: 'classification_status',
        nullable: true,
    })
    classificationStatus: ClassificationStatus | null;

    @Column({ type: 'jsonb', nullable: true })
    decisions: CliSessionClassifiedDecision[] | null;

    @Column({
        type: 'varchar',
        length: 30,
        name: 'classification_source',
        nullable: true,
    })
    classificationSource: ClassificationSource | null;

    @Column({
        type: 'text',
        name: 'classification_error',
        nullable: true,
    })
    classificationError: string | null;

    @Column({
        type: 'timestamp',
        name: 'classified_at',
        nullable: true,
    })
    classifiedAt: Date | null;
}
