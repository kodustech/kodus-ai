import { ProfileConfigKey } from "@/core/domain/profileConfigs/enum/profileConfigKey.enum";
import { CoreModel } from "@/shared/infrastructure/repositories/model/typeOrm";
import { Column, Entity, JoinColumn, ManyToOne } from "typeorm";
import { ProfileModel } from "./profile.model";

@Entity('profile_configs')
export class ProfileConfigModel extends CoreModel {
    @Column({
        type: 'enum',
        enum: ProfileConfigKey,
    })
    configKey: ProfileConfigKey;

    @Column({ type: 'jsonb' })
    configValue: any;

    @Column({ default: true })
    public status: boolean;

    @ManyToOne(() => ProfileModel, (profile) => profile.profileConfigs)
    @JoinColumn({ name: 'profile_id', referencedColumnName: 'uuid' })
    profile: ProfileModel;
}
