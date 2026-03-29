import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

export type GithubAuthDetail = {
    authToken: string;
    installationId?: string;
    org: string;
    authMode?: AuthMode;
    host?: string;
    accountType?: 'organization' | 'user'; // Cache para evitar verificações repetidas
};
