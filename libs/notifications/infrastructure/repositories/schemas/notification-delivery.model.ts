import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { OrganizationModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/organization.model';
import { UserModel } from '@libs/identity/infrastructure/adapters/repositories/schemas/user.model';

import { Criticality } from '../../../domain/enums/criticality.enum';
import { DeliveryStatus } from '../../../domain/enums/delivery-status.enum';
import { NotificationChannel } from '../../../domain/enums/channel.enum';
import type { UserNotificationModel } from './user-notification.model';

@Entity({ name: 'notification_deliveries' })
@Index('IDX_nd_org_event', ['organization', 'event'])
@Index('IDX_nd_channel_status', ['channel', 'deliveryStatus'])
@Index('IDX_nd_correlation', ['correlationId'])
@Index('IDX_nd_created', ['createdAt'])
// Partial index used by the retry worker to claim deliveries that are
// ready to re-attempt. Only rows with attempts > 0 are candidates;
// the worker reads them ordered by nextAttemptAt.
@Index('IDX_nd_retry_ready', ['nextAttemptAt'], {
    where: '"deliveryStatus" = \'pending\' AND "attempts" > 0',
})
export class NotificationDeliveryModel extends CoreModel {
    @ManyToOne(() => OrganizationModel, { nullable: false })
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @ManyToOne(() => UserModel, { nullable: true })
    @JoinColumn({ name: 'recipient_user_id', referencedColumnName: 'uuid' })
    recipientUser?: UserModel;

    @Column({ type: 'text' })
    event: string;

    @Column({ type: 'enum', enum: Criticality })
    criticality: Criticality;

    @Column({ type: 'enum', enum: NotificationChannel })
    channel: NotificationChannel;

    @Column({ type: 'text' })
    title: string;

    @Column({ type: 'text' })
    body: string;

    @Column({ type: 'text', nullable: true })
    ctaUrl?: string;

    @Column({ type: 'text' })
    category: string;

    @Column({ type: 'text', nullable: true })
    recipientEmail?: string;

    /**
     * Snapshot of the recipient's role at dispatch time. Stored on the
     * delivery row so the retry worker can rebuild the
     * NotificationDeliveryContext without re-querying the user.
     */
    @Column({ type: 'text', nullable: true })
    recipientRole?: string;

    @Column({
        type: 'enum',
        enum: DeliveryStatus,
        default: DeliveryStatus.PENDING,
    })
    deliveryStatus: DeliveryStatus;

    @Column({ type: 'jsonb', default: {} })
    metadata: Record<string, unknown>;

    @Column({ type: 'text' })
    correlationId: string;

    @Column({ type: 'text', nullable: true })
    lastError?: string;

    @Column({ type: 'timestamp', nullable: true })
    deliveredAt?: Date;

    /**
     * Number of delivery attempts so far. 0 before the first call; the
     * dispatcher increments to 1 on the first attempt and the retry
     * worker increments on each subsequent re-attempt.
     */
    @Column({ type: 'int', default: 0 })
    attempts: number;

    /** When the next retry should be picked up by the worker. NULL when not scheduled. */
    @Column({ type: 'timestamp', nullable: true })
    nextAttemptAt?: Date | null;

    /** Set while a worker is actively delivering this row. */
    @Column({ type: 'timestamp', nullable: true })
    lockedAt?: Date | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    lockedBy?: string | null;

    @OneToMany('UserNotificationModel', 'delivery')
    userNotifications?: UserNotificationModel[];
}
