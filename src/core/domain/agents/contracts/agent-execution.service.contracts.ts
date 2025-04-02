import { AgentExecutionEntity } from '../entities/agent.execution.entity';
import { IAgentExecution } from '../interfaces/agent-execution.interface';
import { IAgentExecutionRepository } from './agent-execution.repository.contracts';

export const AGENT_EXECUTION_SERVICE_TOKEN = Symbol('AgentExecutionService');

export interface IAgentExecutionService extends IAgentExecutionRepository {
    register(
        agentExecution: Omit<IAgentExecution, 'uuid'>,
    ): Promise<AgentExecutionEntity>;
}
