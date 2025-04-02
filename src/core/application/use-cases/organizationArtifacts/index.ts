import { DismissOrganizationArtifactsUseCase } from './dismiss-organization-artifacts.use-case';
import { ExecuteOrganizationArtifactsUseCase } from './execute-organization-artifacts.use-case';
import { GetOrganizationArtifactsUseCase } from './get-organization-artifacts.use-case';

export const UseCases = [
    ExecuteOrganizationArtifactsUseCase,
    GetOrganizationArtifactsUseCase,
    DismissOrganizationArtifactsUseCase,
];
