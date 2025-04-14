import { AuthMode } from '../../platformIntegrations/enums/codeManagement/authMode.enum';

export type AzureReposAuthDetail = {
    orgUrl: string;
    token: string;
    orgName: string;
    authMode: AuthMode;
};
