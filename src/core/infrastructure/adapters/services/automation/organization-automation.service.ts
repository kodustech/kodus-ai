import { IOrganizationAutomationRepository, ORGANIZATION_AUTOMATION_REPOSITORY_TOKEN } from '@/core/domain/automation/contracts/organization-automation.repository';
import { IOrganizationAutomationService } from '@/core/domain/automation/contracts/organization-automation.service';
import { OrganizationAutomationEntity } from '@/core/domain/automation/entities/organization-automation.entity';
import { IOrganizationAutomation } from '@/core/domain/automation/interfaces/organization-automation.interface';
import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class OrganizationAutomationService implements IOrganizationAutomationService {
    constructor(
        @Inject(ORGANIZATION_AUTOMATION_REPOSITORY_TOKEN)
        private readonly organizationAutomationRepository: IOrganizationAutomationRepository,
    ) { }

    create(organizationAutomation: IOrganizationAutomation): Promise<OrganizationAutomationEntity> {
        return this.organizationAutomationRepository.create(organizationAutomation);
    }

    async update(filter: Partial<IOrganizationAutomation>, data: Partial<IOrganizationAutomation>): Promise<OrganizationAutomationEntity | undefined> {
        try {
            return await this.organizationAutomationRepository.update(filter, data);
        } catch (error) {
            console.error('Error while updating organization automation:', error);
            throw new Error('Failed to update organization automation');
        }
    }

    delete(uuid: string): Promise<void> {
        return this.organizationAutomationRepository.delete(uuid)
    }
    findById(uuid: string): Promise<OrganizationAutomationEntity | null> {
        return this.organizationAutomationRepository.findById(uuid)
    }
    find(filter?: Partial<IOrganizationAutomation>): Promise<OrganizationAutomationEntity[]> {
        return this.organizationAutomationRepository.find(filter)
    }

    register(
        organizationAutomation: Omit<IOrganizationAutomation, 'uuid'>,
    ): Promise<OrganizationAutomationEntity> {
        return this.create({
            ...organizationAutomation,
            uuid: uuidv4(),
        });
    }

}
