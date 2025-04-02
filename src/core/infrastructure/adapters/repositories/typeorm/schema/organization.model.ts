import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity, JoinColumn, OneToMany } from 'typeorm';
import { TeamModel } from './team.model';
import { UserModel } from './user.model';
import { IntegrationModel } from './integration.model';
import { AuthIntegrationModel } from './authIntegration.model';
import { OrganizationMetricsModel } from './organizationMetrics.model';
import { OrganizationParametersModel } from './organizationParameters.model';
import { TeamMemberModel } from './teamMember.model';
import { OrganizationAutomationModel } from './organizationAutomation.model';

@Entity('organizations')
export class OrganizationModel extends CoreModel {
    @Column()
    name: string;

    @Column({ nullable: true })
    tenantName?: string;

    @Column({ default: true })
    public status: boolean;

    @OneToMany(() => TeamModel, (team) => team.organization)
    teams: TeamModel[];

    @OneToMany(() => TeamMemberModel, (teamMembers) => teamMembers.organization)
    teamMembers: TeamMemberModel[];

    @OneToMany(() => UserModel, (user) => user.organization)
    users: UserModel[];

    @OneToMany(
        () => IntegrationModel,
        (integration) => integration.organization,
    )
    integration: IntegrationModel[];

    @OneToMany(
        () => AuthIntegrationModel,
        (authIntegration) => authIntegration.organization,
    )
    authIntegrations: AuthIntegrationModel[];

    @OneToMany(() => OrganizationMetricsModel, (metric) => metric.organization)
    metrics: OrganizationMetricsModel[];

    @OneToMany(
        () => OrganizationParametersModel,
        (config) => config.organization,
    )
    organizationParameters: OrganizationParametersModel[];

    @OneToMany(
        () => OrganizationAutomationModel,
        (organizationAutomation) => organizationAutomation.organization,
    )
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organizationAutomations: OrganizationAutomationModel[];
}
