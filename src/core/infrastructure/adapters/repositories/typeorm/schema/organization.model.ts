import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity, OneToMany } from 'typeorm';
import { AuthIntegrationModel } from './authIntegration.model';
import { IntegrationModel } from './integration.model';
import { OrganizationParametersModel } from './organizationParameters.model';
import { SSOConfigModel } from './ssoConfig.model';
import { TeamModel } from './team.model';
import { TeamMemberModel } from './teamMember.model';
import { UserModel } from './user.model';

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

    @OneToMany(
        () => OrganizationParametersModel,
        (config) => config.organization,
    )
    organizationParameters: OrganizationParametersModel[];

    @OneToMany(() => SSOConfigModel, (ssoConfig) => ssoConfig.organization)
    ssoConfig: SSOConfigModel[];
}
