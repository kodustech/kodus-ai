import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { SANDBOX_PROVIDER_TOKEN } from '@libs/sandbox/domain/contracts/sandbox.provider';
import { SANDBOX_LEASE_MANAGER_TOKEN } from '@libs/sandbox/domain/contracts/sandbox-lease-manager.contract';
import { E2BSandboxService } from '@libs/sandbox/infrastructure/providers/e2b-sandbox.service';
import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';
import { NullSandboxProvider } from '@libs/sandbox/infrastructure/providers/null-sandbox.service';
import {
    SandboxLeaseModel,
    SandboxLeaseSchema,
} from '@libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model';
import { SandboxLeaseRepository } from '@libs/sandbox/infrastructure/repositories/sandbox-lease.repository';
import { SandboxLeaseManager } from '@libs/sandbox/infrastructure/services/sandbox-lease-manager.service';
import { SandboxLeaseReaperService } from '@libs/sandbox/infrastructure/services/sandbox-lease-reaper.service';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: SandboxLeaseModel.name, schema: SandboxLeaseSchema },
        ]),
    ],
    providers: [
        {
            provide: SANDBOX_PROVIDER_TOKEN,
            useFactory: (configService: ConfigService) => {
                const provider =
                    configService.get<string>('SANDBOX_PROVIDER') || 'auto';

                // Explicit selection respected first.
                if (provider === 'null') {
                    return new NullSandboxProvider();
                }
                if (provider === 'local') {
                    return new LocalSandboxService(configService);
                }
                if (provider === 'e2b') {
                    return new E2BSandboxService(configService);
                }

                // 'auto' (default): prefer E2B when an API key is configured,
                // otherwise fall back to LocalSandbox so self-hosted instances
                // still get native tools (grep, readFile, listDir) for both
                // review and conversation. NullSandbox is reserved for
                // explicit `SANDBOX_PROVIDER=null` (test environments).
                if (configService.get<string>('API_E2B_KEY')) {
                    return new E2BSandboxService(configService);
                }
                return new LocalSandboxService(configService);
            },
            inject: [ConfigService],
        },
        SandboxLeaseRepository,
        {
            provide: SANDBOX_LEASE_MANAGER_TOKEN,
            useClass: SandboxLeaseManager,
        },
        SandboxLeaseReaperService,
    ],
    exports: [SANDBOX_PROVIDER_TOKEN, SANDBOX_LEASE_MANAGER_TOKEN],
})
export class SandboxModule {}
