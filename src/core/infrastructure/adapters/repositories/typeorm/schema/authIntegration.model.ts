import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity, JoinColumn, ManyToOne, OneToOne } from 'typeorm';
import { IntegrationModel } from './integration.model';
import { OrganizationModel } from './organization.model';
import { TeamModel } from './team.model';

@Entity('auth_integrations')
export class AuthIntegrationModel extends CoreModel {
    @Column({ type: 'jsonb' })
    authDetails: any;

    @Column({ type: 'boolean' })
    status: boolean;

    @OneToOne(
        () => IntegrationModel,
        (integration) => integration.authIntegration,
    )
    integration: IntegrationModel;

    @ManyToOne(() => OrganizationModel)
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @ManyToOne(() => TeamModel, (team) => team.integrationConfigs)
    @JoinColumn({ name: 'team_id', referencedColumnName: 'uuid' })
    team: TeamModel;
}
