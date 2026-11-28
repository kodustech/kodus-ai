import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

export type BitbucketAuthDetail = {
    username: string;
    appPassword: string;
    authMode: AuthMode;
    email?: string;
    host?: string;
};

/** Data Center stores its server's address; Cloud stores none. */
export const isDataCenterAuth = (authDetails: { host?: unknown }): boolean =>
    typeof authDetails?.host === 'string' && authDetails.host.trim() !== '';
