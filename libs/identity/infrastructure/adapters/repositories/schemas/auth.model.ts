import { Column, Entity, Index, ManyToOne } from 'typeorm';

import { AuthProvider } from '@libs/core/domain/enums/auth-provider.enum';
import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';
import type { UserModel } from './user.model';

@Entity('auth')
// `userUuid` (implicit FK from the ManyToOne below) had no index — the
// cascade `DELETE FROM auth WHERE "userUuid" = $1` from UserRepository.delete
// was doing a Seq Scan. Also hit on refresh-token issuance when looking up
// existing sessions for a user.
@Index('IDX_auth_user', ['user'], { concurrent: true })
export class AuthModel extends CoreModel {
    @Column({ type: 'text', unique: true })
    refreshToken: string;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    expiryDate: Date;

    @Column({ type: 'boolean', default: false })
    used: boolean;

    @ManyToOne('UserModel', 'auth')
    user: UserModel;

    @Column({ type: 'jsonb', nullable: true, default: null })
    authDetails: any;

    @Column({
        type: 'enum',
        enum: AuthProvider,
        default: AuthProvider.CREDENTIALS,
    })
    authProvider: AuthProvider;
}
