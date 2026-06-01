import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { IntegrationConfigKey } from '@libs/core/domain/enums';
import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { TeamModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/team.model';

import type { IntegrationModel } from './integration.model';

@Entity('integration_configs')
@Index('IDX_integration_configs_integration', ['integration'], {
    concurrent: true,
})
@Index('IDX_integration_configs_team', ['team'], { concurrent: true })
@Index('IDX_integration_configs_key', ['configKey'], { concurrent: true })
@Index('idx_integration_configs_key_team_int', [
    'configKey',
    'team',
    'integration',
])
export class IntegrationConfigModel extends CoreModel {
    @Column({
        type: 'enum',
        enum: IntegrationConfigKey,
    })
    configKey: IntegrationConfigKey;

    @Column({ type: 'jsonb' })
    configValue: any;

    @ManyToOne('IntegrationModel', 'integrationConfigs')
    @JoinColumn({ name: 'integration_id', referencedColumnName: 'uuid' })
    integration: IntegrationModel;

    @ManyToOne(() => TeamModel, (team) => team.integrationConfigs)
    @JoinColumn({ name: 'team_id', referencedColumnName: 'uuid' })
    team: TeamModel;
}
