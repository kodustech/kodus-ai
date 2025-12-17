import { SSOConfigEntity } from '../entities/ssoConfig.entity';
import { SSOConfig, SSOProtocol } from '../interfaces/ssoConfig.interface';

export const SSO_CONFIG_REPOSITORY_TOKEN = Symbol('SSOConfigRepository');

export interface ISSOConfigRepository {
    create<P extends SSOProtocol>(
        sso: Omit<SSOConfig<P>, 'uuid' | 'createdAt' | 'updatedAt'>,
    ): Promise<SSOConfigEntity<P>>;

    update<P extends SSOProtocol>(
        uuid: string,
        sso: Partial<Omit<SSOConfig<P>, 'uuid' | 'createdAt' | 'updatedAt'>>,
    ): Promise<SSOConfigEntity<P>>;

    delete(uuid: string): Promise<void>;

    find<P extends SSOProtocol>(
        sso: Partial<SSOConfig<P>>,
    ): Promise<SSOConfigEntity<P>[]>;

    findOne<P extends SSOProtocol>(
        sso: Partial<SSOConfig<P>>,
    ): Promise<SSOConfigEntity<P> | null>;
}
