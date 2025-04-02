import { CreateOrUpdateOrganizationNameUseCase } from './createOrUpdateOrganizationName';
import { GetOrganizationNameUseCase } from './GetOrganizationName';
import { GetIntegrationGithubUseCase } from './get-integration-github';

export const UseCases = [
    CreateOrUpdateOrganizationNameUseCase,
    GetOrganizationNameUseCase,
    GetIntegrationGithubUseCase,
];
