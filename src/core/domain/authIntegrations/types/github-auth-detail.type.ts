import { AuthMode } from '../../platformIntegrations/enums/codeManagement/authMode.enum';

export type GithubAuthDetail = {
    authToken: string;
    installationId?: string;
    org: string;
    authMode?: AuthMode;
};
