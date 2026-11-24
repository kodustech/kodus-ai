import { Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { IntegrationModel } from '@libs/integrations/infrastructure/adapters/repositories/schemas/integration.model';

import type { UserModel } from './user.model';

/**
 * A non-owner member's read access to one Git connection (an `integrations`
 * row). Owners see every connection and need no rows here.
 */
@Entity('user_connection_access')
@Index('UQ_user_connection_access_user_integration', ['user', 'integration'], {
    unique: true,
})
@Index('IDX_user_connection_access_integration', ['integration'])
export class UserConnectionAccessModel extends CoreModel {
    @ManyToOne('UserModel', { onDelete: 'CASCADE', nullable: false })
    @JoinColumn({ name: 'user_id', referencedColumnName: 'uuid' })
    user: UserModel;

    @ManyToOne(() => IntegrationModel, { onDelete: 'CASCADE', nullable: false })
    @JoinColumn({ name: 'integration_id', referencedColumnName: 'uuid' })
    integration: IntegrationModel;
}
