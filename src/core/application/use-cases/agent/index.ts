import { CheckIfHasActiveSessionsUseCase } from './check-active-session.use-case';
import { CheckIfHasTeamConfigUseCase } from './check-has-team-config.use-case';
import { CreateSessionUseCase } from './create-session.use-case';
import { ExecutionAgentPromptUseCase } from './execute-agent.use-case';
import { ExecutionRouterPromptUseCase } from './execute-router-prompt.use-case';
import { ExecuteToolUseCase } from './execute-tool.use-case';
import { GetAuthDetailsByOrganizationUseCase } from './get-auth-details-by-organization.usecase';
import { GetAuthDetailsUseCase } from './get-auth-details.use-case';
import { GetGuildByUserUseCase } from './get-guild-by-user';
import { GetMemoryUseCase } from './get-memory.use-case';
import { GetRouterUseCase } from './get-router-use-case';
import { SendMetricMessageUseCase } from './send-metrics-message';

export const UseCases = [
    GetRouterUseCase,
    ExecutionRouterPromptUseCase,
    CheckIfHasActiveSessionsUseCase,
    CreateSessionUseCase,
    GetMemoryUseCase,
    GetAuthDetailsUseCase,
    GetAuthDetailsByOrganizationUseCase,
    GetGuildByUserUseCase,
    SendMetricMessageUseCase,
    CheckIfHasTeamConfigUseCase,
    ExecuteToolUseCase,
    ExecutionAgentPromptUseCase,
];
