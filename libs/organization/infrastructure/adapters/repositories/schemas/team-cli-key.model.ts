import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { TeamModel } from './team.model';
import { UserModel } from '@libs/identity/infrastructure/adapters/repositories/schemas/user.model';

@Entity('team_cli_key')
@Index('IDX_team_cli_key_team', ['team'], { concurrent: true })
@Index('IDX_team_cli_key_active', ['active'], { concurrent: true })
@Index('IDX_team_cli_key_keyPrefix', ['keyPrefix'], { concurrent: true })
export class TeamCliKeyModel extends CoreModel {
    @Column()
    name: string;

    @Column({ unique: true })
    keyHash: string;

    @Column({ length: 16, nullable: true })
    keyPrefix?: string;

    @Column({ default: true })
    active: boolean;

    @Column({ type: 'jsonb', default: () => "'{}'" })
    config: Record<string, any>;

    @Column({ nullable: true })
    lastUsedAt?: Date;

    @ManyToOne(() => TeamModel)
    @JoinColumn({ name: 'team_id', referencedColumnName: 'uuid' })
    team: TeamModel;

    @ManyToOne(() => UserModel, { nullable: true })
    @JoinColumn({ name: 'created_by_user_id', referencedColumnName: 'uuid' })
    createdBy?: UserModel;
}
