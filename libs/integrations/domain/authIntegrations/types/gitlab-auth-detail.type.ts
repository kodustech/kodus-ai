import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

export type GitlabAuthDetail = {
    accessToken: string;
    refreshToken?: string;
    tokenType?: string;
    scope?: string;
    authMode?: AuthMode;
    host?: string;
    /**
     * Custom bot username for self-hosted GitLab instances.
     * When set, review commands like `@<botUsername> review` are accepted
     * in addition to the default `@kody` prefix.
     */
    botUsername?: string;
};
