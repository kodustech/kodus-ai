import {
    IOrganizationRepository,
    ORGANIZATION_REPOSITORY_TOKEN,
} from '@/core/domain/organization/contracts/organization.repository.contract';
import { IOrganizationService } from '@/core/domain/organization/contracts/organization.service.contract';
import { OrganizationEntity } from '@/core/domain/organization/entities/organization.entity';
import { IOrganization } from '@/core/domain/organization/interfaces/organization.interface';
import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class OrganizationService implements IOrganizationService {
    constructor(
        @Inject(ORGANIZATION_REPOSITORY_TOKEN)
        private readonly organizationRepository: IOrganizationRepository,
    ) {}

    public update(
        filter: Partial<IOrganization>,
        data: Partial<IOrganization>,
    ): Promise<OrganizationEntity | undefined> {
        return this.organizationRepository.update(filter, data);
    }

    public find(filter: Partial<IOrganization>): Promise<OrganizationEntity[]> {
        return this.organizationRepository.find(filter);
    }

    public findOne(
        filter: Partial<IOrganization>,
    ): Promise<OrganizationEntity> {
        return this.organizationRepository.findOne(filter);
    }

    public findById(uuid: string): Promise<OrganizationEntity> {
        return this.organizationRepository.findById(uuid);
    }

    async findOneByUserId(user_id: string): Promise<OrganizationEntity> {
        return this.organizationRepository.findById(user_id);
    }

    async createOrganizationWithTenant(
        organizationData: Partial<IOrganization>,
    ): Promise<OrganizationEntity> {
        const payload = {
            ...organizationData,
        } as Omit<IOrganization, 'uuid'>;

        const savedOrganization = await this.create(payload);

        return savedOrganization;
    }

    public async create(
        payload: Omit<IOrganization, 'uuid'>,
    ): Promise<OrganizationEntity> {
        const uuid = uuidv4();

        const tenantName = `${payload.name}-${uuid}`;

        return await this.organizationRepository.create({
            ...payload,
            tenantName,
            uuid,
        });
    }

    public async deleteOne(filter: Partial<IOrganization>): Promise<void> {
        await this.organizationRepository.deleteOne(filter);
    }
}
