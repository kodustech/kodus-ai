import {
    AGENT_EXECUTION_REPOSITORY_TOKEN,
    IAgentExecutionRepository,
} from '@/core/domain/agents/contracts/agent-execution.repository.contracts';
import { IAgentExecutionService } from '@/core/domain/agents/contracts/agent-execution.service.contracts';
import { AgentExecutionEntity } from '@/core/domain/agents/entities/agent.execution.entity';
import { IAgentExecution } from '@/core/domain/agents/interfaces/agent-execution.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class AgentExecutionService implements IAgentExecutionService {
    constructor(
        @Inject(AGENT_EXECUTION_REPOSITORY_TOKEN)
        private readonly agentExecutionRepository: IAgentExecutionRepository,
    ) {}

    create(
        agentExecution: Omit<IAgentExecution, 'uuid'>,
    ): Promise<AgentExecutionEntity> {
        return this.agentExecutionRepository.create(agentExecution);
    }

    update(
        filter: Partial<IAgentExecution>,
        data: Partial<IAgentExecution>,
    ): Promise<AgentExecutionEntity> {
        return this.agentExecutionRepository.update(filter, data);
    }

    delete(uuid: string): Promise<void> {
        return this.agentExecutionRepository.delete(uuid);
    }

    findById(uuid: string): Promise<AgentExecutionEntity> {
        return this.agentExecutionRepository.findById(uuid);
    }

    find(filter?: Partial<IAgentExecution>): Promise<AgentExecutionEntity[]> {
        return this.agentExecutionRepository.find(filter);
    }

    getNativeCollection() {
        return this.agentExecutionRepository.getNativeCollection();
    }

    findOne(filter?: Partial<IAgentExecution>): Promise<AgentExecutionEntity> {
        return this.agentExecutionRepository.findOne(filter);
    }

    register(
        agentExecution: Omit<IAgentExecution, 'uuid'>,
    ): Promise<AgentExecutionEntity> {
        return this.create({ ...agentExecution });
    }
}
