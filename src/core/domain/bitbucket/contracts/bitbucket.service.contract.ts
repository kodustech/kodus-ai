import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { InstallationStatus } from '@/shared/domain/enums/github-installation-status.enum';

export const BITBUCKET_SERVICE_TOKEN = Symbol('BitbucketService');

export interface IBitbucketService {}
