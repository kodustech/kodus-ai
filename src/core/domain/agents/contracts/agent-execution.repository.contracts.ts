import { AgentExecutionEntity } from '../entities/agent.execution.entity';
import { IAgentExecution } from '../interfaces/agent-execution.interface';

export const AGENT_EXECUTION_REPOSITORY_TOKEN = Symbol(
    'AgentExecutionRepository',
);

export interface IAgentExecutionRepository {
    create(
        agentExecution: Omit<IAgentExecution, 'uuid'>,
    ): Promise<AgentExecutionEntity>;
    update(
        filter: Partial<IAgentExecution>,
        data: Partial<IAgentExecution>,
    ): Promise<AgentExecutionEntity | undefined>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<AgentExecutionEntity | null>;
    find(filter?: Partial<IAgentExecution>): Promise<AgentExecutionEntity[]>;
    getNativeCollection(): any;
    findOne(
        filter?: Partial<IAgentExecution>,
    ): Promise<AgentExecutionEntity | null>;
}
