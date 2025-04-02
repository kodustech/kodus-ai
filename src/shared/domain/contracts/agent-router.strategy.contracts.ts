import { RunParams } from '@/config/types/general/agentRouter.type';
import { ToolsExecutionResult } from '@/core/infrastructure/adapters/services/agent/tools/interfaces/IToolExecution.interface';

export const AGENT_ROUTER_STRATEGY_TOKEN = Symbol('AgentRouterStrategies');

export interface IAgentRouterStrategy {
    name: string;
    run(runParams: RunParams): Promise<any>;
    runTools(runParams: RunParams): Promise<ToolsExecutionResult>;
}
