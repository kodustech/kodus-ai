import { IIntegrationConnector } from "./IIntegrationConnector";
import type { PublicConfig } from "@config/publicConfig";

export class GitlabConnection implements IIntegrationConnector {
    constructor(private readonly cfg: PublicConfig) {}

    async connect(
        hasConnection: boolean,
        routerConfig: any,
        routerPath?: string,
    ) {
        if (hasConnection) {
            routerConfig.push(
                routerPath || `${routerConfig.pathname}/gitlab/configuration`,
            );
            return;
        }
        const {
            gitlabOauthUrl,
            gitlabClientId,
            gitlabRedirectUrl,
            gitlabScopes,
        } = this.cfg;
        const state = Math.random().toString(36).substring(7);
        window.location.href =
            `${gitlabOauthUrl}?client_id=${gitlabClientId}` +
            `&redirect_uri=${gitlabRedirectUrl}` +
            `&response_type=code` +
            `&scope=${encodeURIComponent(gitlabScopes)}` +
            `&state=${state}`;
    }
}
