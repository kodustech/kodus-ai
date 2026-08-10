import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { ProfileModel } from './profile.model';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { ProfileConfigKey } from '@libs/identity/domain/profile-configs/enum/profileConfigKey.enum';

@Entity('profile_configs')
// One config per (profile, key). Doubles as the lookup index for the hot
// `findOne({ profile: { uuid }, configKey })` path AND as the DB-level
// guard against the race that ProfileConfigService.createOrUpdateConfig
// used to hit (two concurrent callers each seeing null on findOne and
// both taking the create branch — duplicate rows). Ships in a dedicated
// migration because a preflight de-dup step is required before the
// UNIQUE can be built on existing data.
@Index('UQ_profile_configs_profile_key', ['profile', 'configKey'], {
    unique: true,
    synchronize: false,
})
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

    @ManyToOne('ProfileModel', 'profileConfigs')
    @JoinColumn({ name: 'profile_id', referencedColumnName: 'uuid' })
    profile: ProfileModel;
}
