import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { OrganizationModel } from './organization.model';
import { TeamAutomationModel } from './teamAutomation.model';
import { MetricsModel } from './metrics.model';
import { IntegrationConfigModel } from './integrationConfig.model';
import { ParametersModel } from './parameters.model';
import { SprintModel } from './sprint.model';
import { STATUS } from '@/config/types/database/status.type';
import { TeamMemberModel } from './teamMember.model';
import { IntegrationModel } from './integration.model';
import { AuthIntegrationModel } from './authIntegration.model';

@Entity('teams')
export class TeamModel extends CoreModel {
    @Column()
    name: string;

    @Column({ type: 'enum', enum: STATUS, default: STATUS.PENDING })
    status: STATUS;

    @ManyToOne(() => OrganizationModel, (organization) => organization.teams)
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @OneToMany(
        () => TeamAutomationModel,
        (teamAutomation) => teamAutomation.team,
    )
    @JoinColumn({ name: 'team_id', referencedColumnName: 'uuid' })
    teamAutomations: TeamAutomationModel[];

    @OneToMany(() => MetricsModel, (metric) => metric.team)
    metrics: MetricsModel[];

    @OneToMany(() => AuthIntegrationModel, (config) => config.team)
    authIntegration: AuthIntegrationModel[];

    @OneToMany(() => IntegrationModel, (config) => config.team)
    integration: IntegrationModel[];

    @OneToMany(() => IntegrationConfigModel, (config) => config.team)
    integrationConfigs: IntegrationConfigModel[];

    @OneToMany(() => ParametersModel, (config) => config.team)
    parameters: ParametersModel[];

    @OneToMany(() => SprintModel, (config) => config.team)
    sprints: SprintModel[];

    @OneToMany(() => TeamMemberModel, (teamMember) => teamMember.team)
    teamMember: TeamMemberModel[];
}
