import {
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    Unique,
} from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { UserModel } from '@libs/identity/infrastructure/adapters/repositories/schemas/user.model';

import type { NotificationDeliveryModel } from './notification-delivery.model';

@Entity({ name: 'user_notifications' })
@Index('IDX_un_user_read', ['user', 'readAt'])
@Index('IDX_un_user_created', ['user', 'createdAt'])
@Unique('UQ_un_delivery', ['delivery'])
export class UserNotificationModel extends CoreModel {
    @ManyToOne(() => UserModel, { nullable: false })
    @JoinColumn({ name: 'user_id', referencedColumnName: 'uuid' })
    user: UserModel;

    @ManyToOne('NotificationDeliveryModel', 'userNotifications', {
        onDelete: 'CASCADE',
    })
    @JoinColumn({ name: 'delivery_id', referencedColumnName: 'uuid' })
    delivery: NotificationDeliveryModel;

    @Column({ type: 'timestamp', nullable: true })
    readAt?: Date | null;
}
