import { GetWorkspaceIdUseCase } from './get-workspace-id.use-case';
import { GetConnectionsUseCase } from './get-connections.use-case';
import { GetPlatformsIntegrationsUseCase } from './get-platforms-integrations.use-case';
import { GetOrganizationIdUseCase } from './get-organization-id.use-case';
import { CreateOrUpdateIntegrationConfigUseCase } from './integrationConfig/createOrUpdateIntegrationConfig.use-case';
import { GetIntegrationConfigsByIntegrationCategoryUseCase } from './integrationConfig/getIntegrationConfigsByIntegrationCategory.use-case';
import { CloneIntegrationUseCase } from './clone-integration.use-case';
import { CheckHasIntegrationByPlatformUseCase } from './check-has-connection.use-case';

export const UseCases = [
    GetConnectionsUseCase,
    GetWorkspaceIdUseCase,
    GetPlatformsIntegrationsUseCase,
    GetOrganizationIdUseCase,
    CloneIntegrationUseCase,
    CheckHasIntegrationByPlatformUseCase,
];

export const UseCasesIntegrationConfig = [
    GetIntegrationConfigsByIntegrationCategoryUseCase,
    CreateOrUpdateIntegrationConfigUseCase,
];
