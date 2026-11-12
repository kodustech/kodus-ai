import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

export type GithubAuthDetail = {
    authToken: string;
    installationId?: string;
    org: string;
    authMode?: AuthMode;
    host?: string;
    accountType?: 'organization' | 'user'; // Cache para evitar verificações repetidas
    /** Row id of the stored credential (not secret). Set on read. */
    authIntegrationId?: string;
    /** Last write of the stored credential row. Set on read. */
    authUpdatedAt?: Date | string;
};
