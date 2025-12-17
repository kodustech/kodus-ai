import {
    ISSOConfigRepository,
    SSO_CONFIG_REPOSITORY_TOKEN,
} from '@/core/domain/auth/contracts/ssoConfig.repository.contract';
import { ISSOConfigService } from '@/core/domain/auth/contracts/ssoConfig.service.contract';
import { SSOConfigEntity } from '@/core/domain/auth/entities/ssoConfig.entity';
import {
    SSOConfig,
    SSOProtocol,
} from '@/core/domain/auth/interfaces/ssoConfig.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class SSOConfigService implements ISSOConfigService {
    constructor(
        @Inject(SSO_CONFIG_REPOSITORY_TOKEN)
        private readonly ssoRepository: ISSOConfigRepository,
    ) {}

    create<P extends SSOProtocol>(
        sso: Omit<SSOConfig<P>, 'uuid' | 'createdAt' | 'updatedAt'>,
    ): Promise<SSOConfigEntity<P>> {
        return this.ssoRepository.create(sso);
    }

    update<P extends SSOProtocol>(
        uuid: string,
        sso: Partial<Omit<SSOConfig<P>, 'uuid' | 'createdAt' | 'updatedAt'>>,
    ): Promise<SSOConfigEntity<P>> {
        return this.ssoRepository.update(uuid, sso);
    }

    delete(uuid: string): Promise<void> {
        return this.ssoRepository.delete(uuid);
    }

    find<P extends SSOProtocol>(
        sso: Partial<SSOConfig<P>>,
    ): Promise<SSOConfigEntity<P>[]> {
        return this.ssoRepository.find(sso);
    }

    findOne<P extends SSOProtocol>(
        sso: Partial<SSOConfig<P>>,
    ): Promise<SSOConfigEntity<P> | null> {
        return this.ssoRepository.findOne(sso);
    }
}
