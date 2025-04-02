import {
    AUTOMATION_EXECUTION_REPOSITORY_TOKEN,
    IAutomationExecutionRepository,
} from '@/core/domain/automation/contracts/automation-execution.repository';
import { IAutomationExecutionService } from '@/core/domain/automation/contracts/automation-execution.service';
import { AutomationExecutionEntity } from '@/core/domain/automation/entities/automation-execution.entity';
import { IAutomationExecution } from '@/core/domain/automation/interfaces/automation-execution.interface';
import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class AutomationExecutionService implements IAutomationExecutionService {
    constructor(
        @Inject(AUTOMATION_EXECUTION_REPOSITORY_TOKEN)
        private readonly automationExecutionRepository: IAutomationExecutionRepository,
    ) { }

    findLatestExecutionByDataExecutionFilter(
        dataExecutionFilter: Partial<any>,
        additionalFilters?: Partial<any>,
    ): Promise<AutomationExecutionEntity | null> {
        return this.automationExecutionRepository.findLatestExecutionByDataExecutionFilter(
            dataExecutionFilter,
            additionalFilters,
        );
    }

    async findOneByOrganizationIdAndIssueId(
        organizationId: string,
        issueId: string,
    ): Promise<boolean> {
        const automation = await this.automationExecutionRepository.find();

        return automation?.some(
            (item) =>
                item?.dataExecution?.issueId === issueId &&
                item?.dataExecution?.organizationId === organizationId,
        );
    }

    create(
        automationExecution: IAutomationExecution,
    ): Promise<AutomationExecutionEntity> {
        return this.automationExecutionRepository.create(automationExecution);
    }

    update(
        filter: Partial<IAutomationExecution>,
        data: Partial<IAutomationExecution>,
    ): Promise<AutomationExecutionEntity> {
        return this.automationExecutionRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.automationExecutionRepository.delete(uuid);
    }

    findById(uuid: string): Promise<AutomationExecutionEntity> {
        return this.automationExecutionRepository.findById(uuid);
    }

    find(
        filter?: Partial<IAutomationExecution>,
    ): Promise<AutomationExecutionEntity[]> {
        return this.automationExecutionRepository.find(filter);
    }

    register(
        automationExecution: Omit<IAutomationExecution, 'uuid'>,
    ): Promise<AutomationExecutionEntity> {
        return this.create({ ...automationExecution, uuid: uuidv4() });
    }
}
