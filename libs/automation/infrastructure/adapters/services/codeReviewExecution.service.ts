import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import {
    CODE_REVIEW_EXECUTION_REPOSITORY,
    ICodeReviewExecutionRepository,
} from '@libs/automation/domain/codeReviewExecutions/contracts/codeReviewExecution.repository.contract';
import { ICodeReviewExecutionService } from '@libs/automation/domain/codeReviewExecutions/contracts/codeReviewExecution.service.contract';
import { CodeReviewExecutionEntity } from '@libs/automation/domain/codeReviewExecutions/entities/codeReviewExecution.entity';
import { CodeReviewExecution } from '@libs/automation/domain/codeReviewExecutions/interfaces/codeReviewExecution.interface';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';

@Injectable()
export class CodeReviewExecutionService<
    T,
> implements ICodeReviewExecutionService<T> {
    private readonly logger = createLogger(CodeReviewExecutionService.name);
    constructor(
        @Inject(CODE_REVIEW_EXECUTION_REPOSITORY)
        private readonly codeReviewExecutionRepository: ICodeReviewExecutionRepository<T>,
    ) {}

    create(
        codeReviewExecution: Omit<
            CodeReviewExecution<T>,
            'uuid' | 'createdAt' | 'updatedAt'
        >,
    ): Promise<CodeReviewExecutionEntity<T> | null> {
        return this.codeReviewExecutionRepository.create(codeReviewExecution);
    }

    updateById(
        uuid: string,
        data: Partial<
            Omit<CodeReviewExecution<T>, 'uuid' | 'createdAt' | 'updatedAt'>
        >,
    ): Promise<CodeReviewExecutionEntity<T> | null> {
        return this.codeReviewExecutionRepository.update({ uuid } as any, data);
    }

    update(
        filter: Partial<CodeReviewExecution<T>>,
        codeReviewExecution: Partial<
            Omit<CodeReviewExecution<T>, 'uuid' | 'createdAt' | 'updatedAt'>
        >,
    ): Promise<CodeReviewExecutionEntity<T> | null> {
        return this.codeReviewExecutionRepository.update(
            filter,
            codeReviewExecution,
        );
    }

    find(
        filter?: Partial<CodeReviewExecution<T>>,
    ): Promise<CodeReviewExecutionEntity<T>[]> {
        return this.codeReviewExecutionRepository.find(filter);
    }

    findOne(
        filter?: Partial<CodeReviewExecution<T>>,
    ): Promise<CodeReviewExecutionEntity<T> | null> {
        return this.codeReviewExecutionRepository.findOne(filter);
    }

    findManyByAutomationExecutionIds(
        uuids: string[],
        options?: {
            visibility?: string;
        },
    ): Promise<CodeReviewExecutionEntity<T>[]> {
        return this.codeReviewExecutionRepository.findManyByAutomationExecutionIds(
            uuids,
            options,
        );
    }

    delete(uuid: string): Promise<boolean> {
        return this.codeReviewExecutionRepository.delete(uuid);
    }

    async findLatestInProgress(
        executionId: string,
        stageName: string,
    ): Promise<CodeReviewExecutionEntity<T> | null> {
        const found = await this.codeReviewExecutionRepository.find({
            automationExecution: { uuid: executionId } as any,
            stageName,
            status: AutomationStatus.IN_PROGRESS,
        });

        if (!found || found.length === 0) {
            return null;
        }

        found.sort((a, b) => {
            const dateA = new Date(a.createdAt).getTime();
            const dateB = new Date(b.createdAt).getTime();
            return dateB - dateA;
        });

        return found[0];
    }

    existsByAutomationExecutionAndStageStatus(
        executionId: string,
        stageNames: string[],
        statuses: AutomationStatus[],
    ): Promise<boolean> {
        return this.codeReviewExecutionRepository.existsByAutomationExecutionAndStageStatus(
            executionId,
            stageNames,
            statuses,
        );
    }
}
