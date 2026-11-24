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
    SecurityScanCoverageModel,
    SecurityScanCoverageSchema,
} from './infrastructure/security-scan-coverage.model';
import {
    SecurityScanScheduleModel,
    SecurityScanScheduleSchema,
} from './infrastructure/security-scan-schedule.model';
import {
    SECURITY_SCAN_REPOSITORY_TOKEN,
    SecurityScanRepository,
} from './infrastructure/security-scan.repository';
import { SecurityScanJobProcessor } from './application/security-scan-job.processor';
import { StartSecurityScanUseCase } from './application/start-security-scan.use-case';
import { GetSecurityScansUseCase } from './application/get-security-scans.use-case';
import { CancelSecurityScanUseCase } from './application/cancel-security-scan.use-case';
import { DeepScanGate } from './application/deep-scan.gate';
import { SecurityScanSchedulesUseCase } from './application/security-scan-schedules.use-case';
import { ExportScanIssuesUseCase } from './application/export-scan-issues.use-case';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import {
    SECURITY_SCAN_SCHEDULE_REPOSITORY_TOKEN,
    SecurityScanScheduleRepository,
} from './infrastructure/security-scan-schedule.repository';
import {
    SECURITY_SCAN_QUEUE_PROBE_TOKEN,
    SecurityScanQueueProbe,
} from './infrastructure/security-scan-queue.probe';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: SecurityScanModel.name, schema: SecurityScanSchema },
            {
                name: SecurityScanCoverageModel.name,
                schema: SecurityScanCoverageSchema,
            },
            {
                name: SecurityScanScheduleModel.name,
                schema: SecurityScanScheduleSchema,
            },
        ]),
        SandboxModule,
        forwardRef(() => PlatformModule),
        forwardRef(() => PermissionValidationModule),
        AnalyticsModule,
        SpendLimitModule,
        forwardRef(() => IssuesModule),
        forwardRef(() => IntegrationConfigModule),
        forwardRef(() => OrganizationModule),
        forwardRef(() => McpCoreModule),
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
        {
            provide: SECURITY_SCAN_QUEUE_PROBE_TOKEN,
            useClass: SecurityScanQueueProbe,
        },
        StartSecurityScanUseCase,
        GetSecurityScansUseCase,
        CancelSecurityScanUseCase,
        DeepScanGate,
        {
            provide: SECURITY_SCAN_SCHEDULE_REPOSITORY_TOKEN,
            useClass: SecurityScanScheduleRepository,
        },
        SecurityScanSchedulesUseCase,
        ExportScanIssuesUseCase,
    ],
    exports: [
        SECURITY_SCAN_REPOSITORY_TOKEN,
        SecurityScanJobProcessor,
        StartSecurityScanUseCase,
        GetSecurityScansUseCase,
        CancelSecurityScanUseCase,
        DeepScanGate,
        SecurityScanSchedulesUseCase,
        ExportScanIssuesUseCase,
    ],
})
export class SecurityScanModule {}
