import { GetIntegrationGithubUseCase } from './get-integration-github';
import { GetInstallationAuthorizationUseCase } from './get-installation-authorization.use-case';
import { GetOrganizationNameUseCase } from './getOrganizationName.use-case';

export const UseCases = [
    GetOrganizationNameUseCase,
    GetIntegrationGithubUseCase,
    GetInstallationAuthorizationUseCase,
];
