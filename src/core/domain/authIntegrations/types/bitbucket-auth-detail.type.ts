import { AuthMode } from '../../platformIntegrations/enums/codeManagement/authMode.enum';

export type BitbucketAuthDetail = {
    username: string;
    appPassword: string;
    authMode: AuthMode;
};
