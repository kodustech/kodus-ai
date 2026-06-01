import { INTEGRATIONS_KEY } from "@enums";
import type { PublicConfig } from "@config/publicConfig";

import { AzureReposConnection } from "./azureReposConnection";
import { BitbucketConnection } from "./bitbucketConnection";
import { ForgejoConnection } from "./forgejoConnection";
import { GitHubConnection } from "./gitHubConnection";
import { GitlabConnection } from "./gitlabConnection";
import { IIntegrationConnector } from "./IIntegrationConnector";

class IntegrationFactory {
    // Connectors that do not depend on PublicConfig stay as singletons
    // instantiated at module load. AzureRepos and Forgejo keep their
    // current per-provider install flow (no OAuth URL in bundle).
    private staticConnectors: Record<string, IIntegrationConnector>;

    constructor() {
        this.staticConnectors = {
            [INTEGRATIONS_KEY.AZURE_REPOS]: new AzureReposConnection(),
            [INTEGRATIONS_KEY.FORGEJO]: new ForgejoConnection(),
        };
    }

    getConnector(
        key: string,
        cfg: PublicConfig,
    ): IIntegrationConnector | null {
        const k = key.toLowerCase();
        switch (k) {
            // Instantiated per-call so OAuth / install URL values can
            // come from useConfig() in the caller — no process.env
            // reads in the client bundle.
            case INTEGRATIONS_KEY.GITHUB:
                return new GitHubConnection(cfg);
            case INTEGRATIONS_KEY.GITLAB:
                return new GitlabConnection(cfg);
            case INTEGRATIONS_KEY.BITBUCKET:
                return new BitbucketConnection(cfg);
            default:
                return this.staticConnectors[k] ?? null;
        }
    }
}

const factoryInstance = new IntegrationFactory();

export default factoryInstance;
