import { ISSOConfigRepository } from '@/core/domain/auth/contracts/ssoConfig.repository.contract';
import { SSOConfigEntity } from '@/core/domain/auth/entities/ssoConfig.entity';
import {
    SSOConfig,
    SSOProtocol,
} from '@/core/domain/auth/interfaces/ssoConfig.interface';
import {
    mapSimpleModelsToEntities,
    mapSimpleModelToEntity,
} from '@/shared/infrastructure/repositories/mappers';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ArrayContains, FindOptionsWhere, Repository } from 'typeorm';
import { SSOConfigModel } from './schema/ssoConfig.model';

@Injectable()
export class SSOConfigRepository implements ISSOConfigRepository {
    constructor(
        @InjectRepository(SSOConfigModel)
        private readonly ssoConfigRepository: Repository<SSOConfigModel>,
    ) {}

    async create<P extends SSOProtocol>(
        sso: Omit<SSOConfig<P>, 'uuid' | 'createdAt' | 'updatedAt'>,
    ): Promise<SSOConfigEntity<P>> {
        const ssoConfigModel = this.ssoConfigRepository.create(sso);

        const ssoConfig = await this.ssoConfigRepository.save(ssoConfigModel);

        return mapSimpleModelToEntity(ssoConfig, SSOConfigEntity);
    }

    async update<P extends SSOProtocol>(
        uuid: string,
        sso: Partial<Omit<SSOConfig<P>, 'uuid' | 'createdAt' | 'updatedAt'>>,
    ): Promise<SSOConfigEntity<P>> {
        await this.ssoConfigRepository.update({ uuid }, sso);

        const ssoConfig = await this.ssoConfigRepository.findOne({
            where: { uuid },
            relations: ['organization'],
        });

        return mapSimpleModelToEntity(ssoConfig, SSOConfigEntity);
    }

    async delete(uuid: string): Promise<void> {
        await this.ssoConfigRepository.delete({ uuid });
    }

    async find<P extends SSOProtocol>(
        sso: Partial<SSOConfig<P>>,
    ): Promise<SSOConfigEntity<P>[]> {
        const ssoConfigModel = await this.ssoConfigRepository.find({
            where: this.getFilterConditions(sso),
            relations: ['organization'],
        });

        return mapSimpleModelsToEntities(ssoConfigModel, SSOConfigEntity);
    }

    async findOne<P extends SSOProtocol>(
        sso: Partial<SSOConfig<P>>,
    ): Promise<SSOConfigEntity<P> | null> {
        const ssoConfigModel = await this.ssoConfigRepository.findOne({
            where: this.getFilterConditions(sso),
            relations: ['organization'],
        });

        return mapSimpleModelToEntity(ssoConfigModel, SSOConfigEntity);
    }

    private getFilterConditions<P extends SSOProtocol>(
        filter: Partial<SSOConfig<P>>,
    ): FindOptionsWhere<SSOConfigModel> {
        const { organization, domains, ...rest } = filter;

        const where: FindOptionsWhere<SSOConfigModel> = {
            ...rest,
        };

        if (organization && organization.uuid) {
            where.organization = {
                uuid: organization.uuid,
            };
        }

        if (domains && domains.length > 0) {
            where.domains = ArrayContains(domains);
        }

        return where;
    }
}
