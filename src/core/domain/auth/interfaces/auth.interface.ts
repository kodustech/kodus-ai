import { AuthProvider } from '@/shared/domain/enums/auth-provider.enum';
import { IUser } from '../../user/interfaces/user.interface';

export interface IAuth {
    uuid: string;
    user?: IUser;
    refreshToken: string;
    used: boolean;
    expiryDate: Date;
    authDetails?: any;
    authProvider: AuthProvider;
}
