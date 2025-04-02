import { AuthMode } from '../../platformIntegrations/enums/codeManagement/authMode.enum';

export type GitlabAuthDetail = {
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    scope?: string;
    authMode?: AuthMode;
    host?: string;
};
