import { Injectable } from '@nestjs/common';

import integrationDescriptions from '../../../config/integration-descriptions.json';

interface IntegrationDescriptions {
    [provider: string]: {
        integrations: {
            [appName: string]: string;
        };
    };
}

@Injectable()
export class IntegrationDescriptionService {
    // Imported at build time via `resolveJsonModule`. Webpack bundles the
    // JSON contents into the compiled main.js, so there's no runtime I/O —
    // works regardless of __dirname / process.cwd() / build layout.
    private descriptions: IntegrationDescriptions =
        integrationDescriptions as IntegrationDescriptions;

    getDescription(provider: string, appName: string): string {
        const providerDescriptions = this.descriptions[provider];
        if (!providerDescriptions) {
            return this.generateFallbackDescription(appName);
        }

        const description = providerDescriptions.integrations[appName];
        if (!description) {
            return this.generateFallbackDescription(appName);
        }

        return description;
    }

    private generateFallbackDescription(appName: string): string {
        const formattedAppName =
            appName.charAt(0).toUpperCase() + appName.slice(1);
        return `Integration with ${formattedAppName} for automation and task management.`;
    }
}
