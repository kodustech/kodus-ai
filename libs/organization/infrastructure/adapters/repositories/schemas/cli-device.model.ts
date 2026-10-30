import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { OrganizationModel } from './organization.model';
import { UserModel } from '@libs/identity/infrastructure/adapters/repositories/schemas/user.model';

@Entity('cli_devices')
@Index('IDX_cli_device_org', ['organization'], { concurrent: true })
@Index('IDX_cli_device_deviceId_org', ['deviceId', 'organization'], {
    unique: true,
    concurrent: true,
})
export class CliDeviceModel extends CoreModel {
    @Column()
    deviceId: string;

    @Column()
    deviceTokenHash: string;

    @ManyToOne(() => OrganizationModel)
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @ManyToOne(() => UserModel, { nullable: true, onDelete: 'CASCADE' })
    @JoinColumn({ name: 'user_id', referencedColumnName: 'uuid' })
    user?: UserModel;

    @Column({ type: 'timestamp', nullable: true })
    lastSeenAt?: Date;

    @Column({ nullable: true })
    userAgent?: string;
}
