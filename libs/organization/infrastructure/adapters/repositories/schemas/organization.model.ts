import { Column, Entity, Index, OneToMany } from 'typeorm';

import {
    DEFAULT_RELEASE_TRACK,
    RELEASE_TRACKS,
    type ReleaseTrack,
} from '@libs/feature-gate/domain/release-track';
import type { SSOConfigModel } from '@libs/ee/sso/repositories/ssoConfig.model';
import type { UserModel } from '@libs/identity/infrastructure/adapters/repositories/schemas/user.model';
import type { AuthIntegrationModel } from '@libs/integrations/infrastructure/adapters/repositories/schemas/authIntegration.model';
import type { IntegrationModel } from '@libs/integrations/infrastructure/adapters/repositories/schemas/integration.model';
import type { OrganizationParametersModel } from './organizationParameters.model';
import type { TeamModel } from './team.model';
import type { TeamMemberModel } from './teamMember.model';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';

@Entity('organizations')
@Index('IDX_organizations_status', ['status'], { concurrent: true })
@Index('IDX_organizations_tenant', ['tenantName'], { concurrent: true })
@Index('IDX_organizations_release_track', ['releaseTrack'], {
    concurrent: true,
})
export class OrganizationModel extends CoreModel {
    @Column()
    name: string;

    @Column({ nullable: true })
    tenantName?: string;

    @Column({ default: true })
    public status: boolean;

    @Column({
        name: 'release_track',
        type: 'enum',
        enum: RELEASE_TRACKS,
        default: DEFAULT_RELEASE_TRACK,
    })
    releaseTrack: ReleaseTrack;

    @OneToMany('TeamModel', 'organization')
    teams: TeamModel[];

    @OneToMany('TeamMemberModel', 'organization')
    teamMembers: TeamMemberModel[];

    @OneToMany('UserModel', 'organization')
    users: UserModel[];

    @OneToMany('IntegrationModel', 'organization')
    integration: IntegrationModel[];

    @OneToMany('AuthIntegrationModel', 'organization')
    authIntegrations: AuthIntegrationModel[];

    @OneToMany('OrganizationParametersModel', 'organization')
    organizationParameters: OrganizationParametersModel[];

    @OneToMany('SSOConfigModel', 'organization')
    ssoConfig: SSOConfigModel[];
}
