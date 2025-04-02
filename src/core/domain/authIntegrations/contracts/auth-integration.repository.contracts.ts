import { AuthIntegrationEntity } from '../entities/auth-integration.entity';
import { IAuthIntegration } from '../interfaces/auth-integration.interface';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';

export const AUTH_INTEGRATION_REPOSITORY_TOKEN = Symbol(
    'AuthIntegrationRepository',
);

export interface IAuthIntegrationRepository {
    find(filter?: Partial<IAuthIntegration>): Promise<AuthIntegrationEntity[]>;
    findById(uuid: string): Promise<AuthIntegrationEntity | undefined>;
    findOne(
        filter?: Partial<IAuthIntegration>,
    ): Promise<AuthIntegrationEntity | undefined>;
    create(
        authIntegrationData: IAuthIntegration,
    ): Promise<AuthIntegrationEntity | undefined>;
    update(
        filter: Partial<IAuthIntegration>,
        data: Partial<IAuthIntegration>,
    ): Promise<AuthIntegrationEntity | undefined>;
    delete(uuid: string): Promise<void>;

    getIntegrationUuidByAuthDetails(
        authDetails: any,
        platformType?: PlatformType,
    ): Promise<string | undefined>;
}
