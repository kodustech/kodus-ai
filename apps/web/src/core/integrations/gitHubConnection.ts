import { IIntegrationConnector } from "./IIntegrationConnector";
import type { PublicConfig } from "@config/publicConfig";

export class GitHubConnection implements IIntegrationConnector {
    constructor(private readonly cfg: PublicConfig) {}

    async connect(
        hasConnection: boolean,
        routerConfig: any,
        routerPath?: string,
    ) {
        if (hasConnection) {
            routerConfig.push(
                routerPath || `${routerConfig.pathname}/github/configuration`,
            );
            return;
        }
        if (!this.cfg.githubInstallUrl) {
            console.warn(
                "[GitHubConnection] WEB_GITHUB_INSTALL_URL is not configured — OAuth redirect cannot proceed.",
            );
            return;
        }
        window.location.href = this.cfg.githubInstallUrl;
    }
}
