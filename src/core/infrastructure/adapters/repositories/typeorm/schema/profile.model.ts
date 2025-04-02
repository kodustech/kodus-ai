import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { Column, Entity, JoinColumn, OneToMany, OneToOne } from 'typeorm';
import { UserModel } from './user.model';
import { ProfileConfigModel } from './profileConfig.model';

@Entity('profiles')
export class ProfileModel extends CoreModel {
    @Column()
    name: string;

    @Column({ nullable: true })
    phone: string;

    @Column({ nullable: true })
    img: string;

    @Column({ nullable: true })
    position: string;

    @Column({ default: true })
    public status: boolean;

    @OneToOne(() => UserModel, (user) => user.profile)
    @JoinColumn({ name: 'user_id', referencedColumnName: 'uuid' })
    user: UserModel;

    @OneToMany(() => ProfileConfigModel, (config) => config.profile)
    profileConfigs: ProfileConfigModel[];
}
