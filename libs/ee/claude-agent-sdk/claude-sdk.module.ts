/**
 * @license
 * Kodus Tech. All rights reserved.
 */

/**
 * Puts Claude calls on the Claude Agent SDK (#2113) by registering the
 * executors in the core's registry. The SDK is proprietary, so it lives here,
 * under the commercial license, and the AGPL core only knows the registry.
 *
 * Cloud: always on. Self-hosted: per organization, with a valid EE license;
 * an organization without one runs Claude on today's path.
 */
import { Inject, Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';

import { environment } from '@libs/ee/configs/environment';
import { LicenseModule } from '@libs/ee/license/license.module';
import { LICENSE_SERVICE_TOKEN, type ILicenseService } from '@libs/ee/license/interfaces/license.interface';

import { registerClaudeSdk, unregisterClaudeSdk, type ClaudeSdkRuntimeParts } from './register';

export { licensedExecutors, registerClaudeSdk, unregisterClaudeSdk } from './register';

@Injectable()
export class ClaudeSdkLifecycle implements OnModuleInit, OnApplicationShutdown {
    private parts?: ClaudeSdkRuntimeParts;

    constructor(@Inject(LICENSE_SERVICE_TOKEN) private readonly license: ILicenseService) {}

    onModuleInit(): void {
        this.parts = registerClaudeSdk({
            cloud: !!environment.API_CLOUD_MODE,
            licensed: async (organizationId) => {
                if (!organizationId) return false;
                try {
                    return (await this.license.validateOrganizationLicense({ organizationId } as any))?.valid === true;
                } catch {
                    return false;
                }
            },
        });
    }

    async onApplicationShutdown(): Promise<void> {
        if (this.parts) await unregisterClaudeSdk(this.parts);
        this.parts = undefined;
    }
}

@Module({
    imports: [LicenseModule],
    providers: [ClaudeSdkLifecycle],
})
export class ClaudeSdkModule {}
