import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { IntegrationModel } from './integration.model';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { TeamModel } from './team.model';

@Entity('integration_configs')
export class IntegrationConfigModel extends CoreModel {
    @Column({
        type: 'enum',
        enum: IntegrationConfigKey,
    })
    configKey: IntegrationConfigKey;

    @Column({ type: 'jsonb' })
    configValue: any;

    @ManyToOne(
        () => IntegrationModel,
        (integration) => integration.integrationConfigs,
    )
    @JoinColumn({ name: 'integration_id', referencedColumnName: 'uuid' })
    integration: IntegrationModel;

    @ManyToOne(() => TeamModel, (team) => team.integrationConfigs)
    @JoinColumn({ name: 'team_id', referencedColumnName: 'uuid' })
    team: TeamModel;
}
