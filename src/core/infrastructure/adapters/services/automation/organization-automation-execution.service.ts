import { IOrganizationAutomationExecutionRepository, ORGANIZATION_AUTOMATION_EXECUTION_REPOSITORY_TOKEN } from '@/core/domain/automation/contracts/organization-automation-execution.repository';
import { IOrganizationAutomationExecutionService } from '@/core/domain/automation/contracts/organization-automation-execution.service';
import { OrganizationAutomationExecutionEntity } from '@/core/domain/automation/entities/organization-automation-execution.entity';
import { IOrganizationAutomationExecution } from '@/core/domain/automation/interfaces/organization-automation-execution.interface';
import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class OrganizationAutomationExecutionService implements IOrganizationAutomationExecutionService {
    constructor(
        @Inject(ORGANIZATION_AUTOMATION_EXECUTION_REPOSITORY_TOKEN)
        private readonly organizationAutomationExecutionRepository: IOrganizationAutomationExecutionRepository,
    ) { }
    async findOneByOrganizationIdAndIssueId(
        organizationId: string,
        issueId: string,
    ): Promise<boolean> {
        const automation = await this.organizationAutomationExecutionRepository.find({
            dataExecution: {
                issueId: issueId,
                organizationId: organizationId
            }
        });

        return automation.length > 0;
    }

    create(
        organizationAutomationExecution: IOrganizationAutomationExecution,
    ): Promise<OrganizationAutomationExecutionEntity> {
        return this.organizationAutomationExecutionRepository.create(organizationAutomationExecution);
    }

    update(
        filter: Partial<IOrganizationAutomationExecution>,
        data: Partial<IOrganizationAutomationExecution>,
    ): Promise<OrganizationAutomationExecutionEntity> {
        return this.organizationAutomationExecutionRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.organizationAutomationExecutionRepository.delete(uuid);
    }

    findById(uuid: string): Promise<OrganizationAutomationExecutionEntity> {
        return this.organizationAutomationExecutionRepository.findById(uuid);
    }

    find(
        filter?: Partial<IOrganizationAutomationExecution>,
    ): Promise<OrganizationAutomationExecutionEntity[]> {
        return this.organizationAutomationExecutionRepository.find(filter);
    }

    register(
        organizationAutomationExecution: Omit<IOrganizationAutomationExecution, 'uuid'>,
    ): Promise<OrganizationAutomationExecutionEntity> {
        return this.create({ ...organizationAutomationExecution, uuid: uuidv4() });
    }
}
