import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IJobQueueService,
    JOB_QUEUE_SERVICE_TOKEN,
} from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { HandlerType } from '@libs/core/workflow/domain/enums/handler-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '@libs/ee/license/interfaces/license.interface';
import {
    heavyModePlansRequired,
    isHeavyModePlanAllowed,
} from '@libs/ee/heavy-mode/heavy-mode-plan';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PricingResolver } from '@libs/analytics/application/use-cases/usage/pricing-resolver';
import { SpendLimitConfigService } from '@libs/analytics/application/spend-limit/spend-limit-config.service';

import { validateBudget } from '../domain/budget-meter';
import { resolveScanModel } from './scan-model';
import { STALE_SCAN_AFTER_MS } from './get-security-scans.use-case';
import {
    SecurityScanBudget,
    SecurityScanRecord,
    SecurityScanStatus,
} from '../domain/security-scan.types';
import {
    ISecurityScanRepository,
    SECURITY_SCAN_REPOSITORY_TOKEN,
} from '../infrastructure/security-scan.repository';

/** Same plans as heavy mode until Product decides the security tier (#2451). */
export const SECURITY_SCAN_PLAN_REQUIRED = heavyModePlansRequired(
    'Security scans are',
);

const ALREADY_RUNNING =
    'A security scan of this repository is already running.';

interface ConfiguredRepository {
    id: string;
    name: string;
    default_branch?: string;
    organizationName?: string;
    full_name?: string;
}

export interface StartSecurityScanInput {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId: string;
    budget: SecurityScanBudget;
    requestedBy?: { userId?: string; email?: string };
}

@Injectable()
export class StartSecurityScanUseCase {
    constructor(
        @Inject(SECURITY_SCAN_REPOSITORY_TOKEN)
        private readonly scans: ISecurityScanRepository,
        @Inject(JOB_QUEUE_SERVICE_TOKEN)
        private readonly jobQueue: IJobQueueService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
        private readonly permissionValidationService: PermissionValidationService,
        private readonly codeManagementService: CodeManagementService,
        private readonly pricingResolver: PricingResolver,
        private readonly spendLimitConfig: SpendLimitConfigService,
    ) {}

    async execute(input: StartSecurityScanInput): Promise<SecurityScanRecord> {
        const orgTeam = input.organizationAndTeamData;

        const allowed = await isHeavyModePlanAllowed(
            this.licenseService,
            orgTeam,
            StartSecurityScanUseCase.name,
        );
        if (!allowed) {
            throw new ForbiddenException(SECURITY_SCAN_PLAN_REQUIRED);
        }

        const repositories =
            (await this.integrationConfigService.findIntegrationConfigFormatted<
                ConfiguredRepository[]
            >(IntegrationConfigKey.REPOSITORIES, orgTeam)) ?? [];
        const repository = repositories.find(
            (r) => String(r.id) === String(input.repositoryId),
        );
        if (!repository) {
            throw new NotFoundException(
                'This repository is not connected to the team.',
            );
        }

        const { model, rates } = await resolveScanModel({
            organizationAndTeamData: orgTeam,
            permissionValidationService: this.permissionValidationService,
            pricingResolver: this.pricingResolver,
            pricingOverrides: (await this.spendLimitConfig.getConfig(orgTeam))
                ?.modelPricing,
        });
        const budgetError = validateBudget(input.budget, !!rates);
        if (budgetError) {
            throw new BadRequestException(budgetError);
        }

        await this.scans.failStale(orgTeam.organizationId, STALE_SCAN_AFTER_MS);
        const active = await this.scans.findActive(
            orgTeam.organizationId,
            String(repository.id),
        );
        if (active) {
            throw new ConflictException(ALREADY_RUNNING);
        }

        const platform =
            await this.codeManagementService.getTypeIntegration(orgTeam);
        const fullName =
            repository.full_name ||
            (repository.name.includes('/')
                ? repository.name
                : `${repository.organizationName ?? ''}/${repository.name}`);

        const scan = await this.scans
            .create({
                organizationId: orgTeam.organizationId,
                teamId: orgTeam.teamId,
                repository: {
                    id: String(repository.id),
                    name: repository.name,
                    fullName,
                    platform: String(platform),
                    defaultBranch: repository.default_branch || 'main',
                },
                status: SecurityScanStatus.QUEUED,
                budget: {
                    ...(input.budget.maxUsd !== undefined && rates
                        ? { maxUsd: input.budget.maxUsd }
                        : {}),
                    ...(input.budget.maxTokens !== undefined
                        ? { maxTokens: input.budget.maxTokens }
                        : {}),
                },
                spend: { usd: 0, inputTokens: 0, outputTokens: 0, requests: 0 },
                units: [],
                progress: [],
                modelName: model.modelName,
                requestedBy: input.requestedBy,
            })
            .catch((error) => {
                // Another request started one between the check above and
                // this write; the one-active-scan index refused the second.
                if (error?.code === 11000) {
                    throw new ConflictException(ALREADY_RUNNING);
                }
                throw error;
            });

        await this.jobQueue.enqueue({
            correlationId: scan.uuid,
            workflowType: WorkflowType.SECURITY_SCAN,
            handlerType: HandlerType.SIMPLE_FUNCTION,
            payload: { scanId: scan.uuid, organizationAndTeamData: orgTeam },
            organizationAndTeamData: orgTeam,
            status: JobStatus.PENDING,
            priority: 0,
            retryCount: 0,
            maxRetries: 2,
        });

        return scan;
    }
}
