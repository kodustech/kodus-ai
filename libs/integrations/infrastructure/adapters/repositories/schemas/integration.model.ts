import {
    Column,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    OneToMany,
    OneToOne,
} from 'typeorm';

import { IntegrationCategory, PlatformType } from '@libs/core/domain/enums';
import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { OrganizationModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/organization.model';
import { TeamModel } from '@libs/organization/infrastructure/adapters/repositories/schemas/team.model';

import type { AuthIntegrationModel } from './authIntegration.model';
import type { IntegrationConfigModel } from './integrationConfig.model';

@Entity('integrations')
@Index(
    'IDX_integration_team_category_status',
    ['team', 'integrationCategory', 'status'],
    { concurrent: true },
)
@Index(
    'IDX_integrations_platform_org_team',
    ['platform', 'organization', 'team'],
    {
        concurrent: true,
    },
)
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

    // Label owners give a Git connection so a workspace with several can tell them apart.
    @Column({ type: 'varchar', length: 120, nullable: true })
    name?: string | null;

    // Per-connection review switch; the workspace automation still has to be on too.
    @Column({ type: 'boolean', default: true })
    reviewEnabled: boolean;

    @ManyToOne(() => OrganizationModel)
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @OneToOne('AuthIntegrationModel', 'integration')
    @JoinColumn({ name: 'auth_integration_id', referencedColumnName: 'uuid' })
    authIntegration: AuthIntegrationModel;

    @ManyToOne(() => TeamModel, (team) => team.integrationConfigs)
    @JoinColumn({ name: 'team_id', referencedColumnName: 'uuid' })
    team: TeamModel;

    @OneToMany('IntegrationConfigModel', 'integration')
    integrationConfigs: IntegrationConfigModel[];
}
