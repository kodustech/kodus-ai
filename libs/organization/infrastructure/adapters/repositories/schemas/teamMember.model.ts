import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { OrganizationModel } from './organization.model';
import { TeamModel } from './team.model';
import { UserModel } from '@libs/identity/infrastructure/adapters/repositories/schemas/user.model';

import { TeamMemberRole } from '@libs/organization/domain/teamMembers/enums/teamMemberRole.enum';
import { ICodeManagementMemberConfig } from '@libs/organization/domain/teamMembers/interfaces/codeManagementMemberConfig.interface';
import { ICommuminicationMemberConfig } from '@libs/organization/domain/teamMembers/interfaces/communicationMemberConfig.interface';
import { IProjectManagementMemberConfig } from '@libs/organization/domain/teamMembers/interfaces/projectManagementMemberConfig';
import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';

@Entity('team_member')
// FKs create constraints, not indexes — every hot-path lookup that filters
// by user_id / (organization_id, team_id) was doing a Seq Scan.
@Index('IDX_team_member_user', ['user'], { concurrent: true })
@Index('IDX_team_member_org_team', ['organization', 'team'], {
    concurrent: true,
})
// Slack/Teams user lookup: communicationId is only set for members with a
// linked chat identity, so a partial index skips the many-null rows. TypeORM
// cannot emit `WHERE communicationId IS NOT NULL`, so synchronize:false and
// the real CREATE lives in the accompanying migration.
@Index('IDX_team_member_comm_id', { synchronize: false })
export class TeamMemberModel extends CoreModel {
    @Column()
    name: string;

    @Column({ default: true })
    status: boolean;

    @Column({ nullable: true })
    avatar: string;

    @Column('jsonb', { nullable: true })
    communication: ICommuminicationMemberConfig;

    @Column('jsonb', { nullable: true })
    codeManagement: ICodeManagementMemberConfig;

    @Column('jsonb', { nullable: true })
    projectManagement: IProjectManagementMemberConfig;

    @Column({ nullable: true })
    communicationId: string;

    @Column({
        type: 'enum',
        enum: TeamMemberRole,
        default: TeamMemberRole.MEMBER,
    })
    teamRole: TeamMemberRole;

    @ManyToOne(() => UserModel, (user) => user.teamMember)
    @JoinColumn({ name: 'user_id', referencedColumnName: 'uuid' })
    user: UserModel;

    @ManyToOne(
        () => OrganizationModel,
        (organization) => organization.teamMembers,
    )
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @ManyToOne(() => TeamModel, (team) => team.teamMember)
    @JoinColumn({ name: 'team_id', referencedColumnName: 'uuid' })
    team: TeamModel;
}
