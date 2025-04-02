import { Column, Entity, ManyToOne } from 'typeorm';
import { UserModel } from './user.model';
import { CoreModel } from '@/shared/infrastructure/repositories/model/typeOrm';
import { AuthProvider } from '@/shared/domain/enums/auth-provider.enum';

@Entity('auth')
export class AuthModel extends CoreModel {
    @Column({ type: 'text', unique: true })
    refreshToken: string;

    @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
    expiryDate: Date;

    @Column({ type: 'boolean', default: false })
    used: boolean;

    @ManyToOne(() => UserModel, (user) => user.auth)
    user: UserModel;

    @Column({ type: 'jsonb', nullable: true, default: null })
    authDetails: any;

    @Column({ type: 'enum', enum: AuthProvider, default: AuthProvider.CREDENTIALS })
    authProvider: AuthProvider;
}
