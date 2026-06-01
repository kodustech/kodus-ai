import { IIntegrationConnector } from "./IIntegrationConnector";
import type { PublicConfig } from "@config/publicConfig";

export class BitbucketConnection implements IIntegrationConnector {
    constructor(private readonly cfg: PublicConfig) {}

    async connect(
        hasConnection: boolean,
        routerConfig: any,
        routerPath?: string,
    ) {
        if (hasConnection) {
            routerConfig.push(
                routerPath ||
                    `${routerConfig.pathname}/bitbucket/configuration`,
            );
            return;
        }
        window.location.href = this.cfg.bitbucketInstallUrl || "";
    }
}
