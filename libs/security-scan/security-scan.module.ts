import { forwardRef, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { JOB_QUEUE_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { WorkflowJobQueueService } from '@libs/core/workflow/infrastructure/workflow-job-queue.service';
import { SandboxModule } from '@libs/sandbox/modules/sandbox.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { PermissionValidationModule } from '@libs/ee/shared/permission-validation.module';
import { AnalyticsModule } from '@libs/analytics/modules/analytics.module';
import { SpendLimitModule } from '@libs/analytics/modules/spend-limit.module';
import { IssuesModule } from '@libs/issues/issues.module';
import { IntegrationConfigModule } from '@libs/integrations/modules/config.module';
import { OrganizationModule } from '@libs/organization/modules/organization.module';

import {
    SecurityScanModel,
    SecurityScanSchema,
} from './infrastructure/security-scan.model';
import {
    SECURITY_SCAN_REPOSITORY_TOKEN,
    SecurityScanRepository,
} from './infrastructure/security-scan.repository';
import { SecurityScanJobProcessor } from './application/security-scan-job.processor';
import { StartSecurityScanUseCase } from './application/start-security-scan.use-case';
import { GetSecurityScansUseCase } from './application/get-security-scans.use-case';
import { DeepScanGate } from './application/deep-scan.gate';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: SecurityScanModel.name, schema: SecurityScanSchema },
        ]),
        SandboxModule,
        forwardRef(() => PlatformModule),
        forwardRef(() => PermissionValidationModule),
        AnalyticsModule,
        SpendLimitModule,
        forwardRef(() => IssuesModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => OrganizationModule),
    ],
    providers: [
        {
            provide: SECURITY_SCAN_REPOSITORY_TOKEN,
            useClass: SecurityScanRepository,
        },
        // Provided here, as AutomationModule does: importing
        // WorkflowModule.register() would close a cycle (the worker's
        // WorkflowModule imports this module for the job processor).
        // Repositories come from the global WorkflowCoreModule.
        {
            provide: JOB_QUEUE_SERVICE_TOKEN,
            useClass: WorkflowJobQueueService,
        },
        SecurityScanJobProcessor,
        StartSecurityScanUseCase,
        GetSecurityScansUseCase,
        DeepScanGate,
    ],
    exports: [
        SECURITY_SCAN_REPOSITORY_TOKEN,
        SecurityScanJobProcessor,
        StartSecurityScanUseCase,
        GetSecurityScansUseCase,
        DeepScanGate,
    ],
})
export class SecurityScanModule {}
