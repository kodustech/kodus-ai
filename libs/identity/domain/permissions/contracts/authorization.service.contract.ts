import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { Action, ResourceType } from '../enums/permissions.enum';

export const AUTHORIZATION_SERVICE_TOKEN = Symbol('AuthorizationService');

export interface IAuthorizationService {
    getRepositoryScope(params: {
        user: Partial<IUser>;
        action: Action;
        resource: ResourceType;
        status?: STATUS[];
    }): Promise<string[] | null>;
}
