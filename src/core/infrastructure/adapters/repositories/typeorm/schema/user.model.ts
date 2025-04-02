import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import {
    Column,
    Entity,
    JoinColumn,
    ManyToOne,
    OneToMany,
    OneToOne,
} from 'typeorm';
import { OrganizationModel } from './organization.model';
import { ProfileModel } from './profile.model';
import { AuthModel } from './auth.model';
import { TeamMemberModel } from './teamMember.model';
import { STATUS } from '@/config/types/database/status.type';
import { UserRole } from '@/core/domain/user/enums/userRole.enum';

@Entity('users')
export class UserModel extends CoreModel {
    @Column({ unique: true, nullable: false })
    email: string;

    @Column({ name: 'password', nullable: false })
    password: string;

    @Column({ type: 'enum', enum: UserRole, default: UserRole.OWNER })
    role: UserRole[];

    @Column({ type: 'enum', enum: STATUS, default: STATUS.PENDING })
    status: STATUS;

    @OneToOne(() => ProfileModel, (profile) => profile.user)
    profile: ProfileModel[];

    @ManyToOne(() => OrganizationModel, (organization) => organization.users)
    @JoinColumn({ name: 'organization_id', referencedColumnName: 'uuid' })
    organization: OrganizationModel;

    @OneToMany(() => AuthModel, (auth) => auth.user)
    auth: AuthModel[];

    @OneToMany(() => TeamMemberModel, (teamMember) => teamMember.user)
    teamMember: TeamMemberModel[];
}
