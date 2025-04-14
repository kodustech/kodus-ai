import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { InstallationStatus } from '@/shared/domain/enums/github-installation-status.enum';

export const AZURE_REPOS_SERVICE_TOKEN = Symbol('AzureReposService');

export interface IAzureReposService {}
