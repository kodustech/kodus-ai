import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { ProfileModel } from './profile.model';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import { ProfileConfigKey } from '@libs/identity/domain/profile-configs/enum/profileConfigKey.enum';

@Entity('profile_configs')
// One config per (profile, key). Doubles as the lookup index for the hot
// `findOne({ profile: { uuid }, configKey })` path AND as the DB-level
// guard against the race that ProfileConfigService.createOrUpdateConfig
// used to hit (two concurrent callers each seeing null on findOne and
// both taking the create branch — duplicate rows). Actual `CREATE
// UNIQUE INDEX CONCURRENTLY` (with preflight de-dup) lives in the
// paired migration; this declaration is only doc + a marker for
// developers grepping models. `synchronize: false` at the entity level
// (kept out of the decorator options because TypeORM's `@Index(name,
// fields, options)` overload doesn't accept it).
@Index('UQ_profile_configs_profile_key', ['profile', 'configKey'], {
    unique: true,
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
