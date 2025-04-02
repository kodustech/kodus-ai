import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import {
    Column,
    Entity,
    JoinColumn,
    ManyToOne,
    OneToMany,
    OneToOne,
} from 'typeorm';
import { IntegrationConfigModel } from './integrationConfig.model';
import { AuthIntegrationModel } from './authIntegration.model';
import { OrganizationModel } from './organization.model';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import { TeamModel } from './team.model';

@Entity('integrations')
export class IntegrationModel extends CoreModel {
    @Column({ type: 'boolean' })
    status: boolean;

    @Column({
        type: 'enum',
        enum: PlatformType,
    })
    platform: PlatformType;

    @Column({ type: 'enum', enum: IntegrationCategory })
    integrationCategory: IntegrationCategory;

    @ManyToOne(() => OrganizationModel)
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @OneToOne(
        () => AuthIntegrationModel,
        (authIntegration) => authIntegration.integration,
    )
    @JoinColumn({ name: 'auth_integration_id', referencedColumnName: 'uuid' })
    authIntegration: AuthIntegrationModel;

    @ManyToOne(() => TeamModel, (team) => team.integrationConfigs)
    @JoinColumn({ name: 'team_id', referencedColumnName: 'uuid' })
    team: TeamModel;

    @OneToMany(() => IntegrationConfigModel, (config) => config.integration)
    integrationConfigs: IntegrationConfigModel[];
}
