import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    Inject,
    Param,
    Post,
    Put,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiBearerAuth,
    ApiOperation,
    ApiProperty,
    ApiPropertyOptional,
    ApiTags,
} from '@nestjs/swagger';
import {
    IsBoolean,
    IsIn,
    IsNumber,
    IsOptional,
    IsPositive,
    IsString,
} from 'class-validator';
import { Type } from 'class-transformer';

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import {
    checkPermissions,
    checkRepoPermissions,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { StartSecurityScanUseCase } from '@libs/security-scan/application/start-security-scan.use-case';
import { GetSecurityScansUseCase } from '@libs/security-scan/application/get-security-scans.use-case';
import { CancelSecurityScanUseCase } from '@libs/security-scan/application/cancel-security-scan.use-case';
import {
    DEEP_SCAN_NOT_ENABLED_MESSAGE,
    DeepScanGate,
} from '@libs/security-scan/application/deep-scan.gate';
import { SecurityScanSchedulesUseCase } from '@libs/security-scan/application/security-scan-schedules.use-case';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';

export class StartSecurityScanDto {
    @ApiProperty()
    @IsString()
    teamId: string;

    @ApiProperty({ description: "The repository's id on the git provider." })
    @IsString()
    repositoryId: string;

    @ApiPropertyOptional({
        description:
            'Spend limit for this scan, in USD. Without a limit the scan covers the whole repository.',
    })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @IsPositive()
    maxUsd?: number;

    @ApiPropertyOptional({
        description:
            'Spend limit in tokens (input + output), for a model without a known price.',
    })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @IsPositive()
    maxTokens?: number;

    @ApiPropertyOptional({
        enum: ['incremental', 'full'],
        description:
            'incremental (default): read only what changed since earlier scans concluded, or was never read. full: read the whole repository again.',
    })
    @IsOptional()
    @IsIn(['incremental', 'full'])
    mode?: 'incremental' | 'full';

    @ApiPropertyOptional({
        description:
            "A model of the organization's AI providers (its id) to run this scan on. Defaults to the Deep scan routing.",
    })
    @IsOptional()
    @IsString()
    modelId?: string;
}

export class SaveSecurityScanScheduleDto {
    @ApiProperty()
    @IsString()
    teamId: string;

    @ApiProperty({ description: "The repository's id on the git provider." })
    @IsString()
    repositoryId: string;

    @ApiProperty({ enum: ['daily', 'weekly'] })
    @IsIn(['daily', 'weekly'])
    cadence: 'daily' | 'weekly';

    @ApiPropertyOptional({ description: 'Spend limit for each run, in USD.' })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @IsPositive()
    maxUsd?: number;

    @ApiPropertyOptional({
        description:
            'Spend limit for each run in tokens, for a model without a known price.',
    })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @IsPositive()
    maxTokens?: number;

    @ApiPropertyOptional({ enum: ['incremental', 'full'] })
    @IsOptional()
    @IsIn(['incremental', 'full'])
    mode?: 'incremental' | 'full';

    @ApiPropertyOptional({
        description:
            "A model of the organization's AI providers (its id). Defaults to the Deep scan routing.",
    })
    @IsOptional()
    @IsString()
    modelId?: string;

    @ApiPropertyOptional({
        description: 'Pause the schedule without deleting it.',
    })
    @IsOptional()
    @IsBoolean()
    enabled?: boolean;
}

// A scan spends the organization's model budget on one repository.
const canStartScan = checkRepoPermissions({
    action: Action.Create,
    resource: ResourceType.SecurityScan,
    repo: { key: { body: 'repositoryId' } },
});

// A schedule spends the organization's model budget on one repository, on a
// clock: the same grant as starting a scan, on that repository.
const canScheduleScan = checkRepoPermissions({
    action: Action.Create,
    resource: ResourceType.SecurityScan,
    repo: { key: { body: 'repositoryId', params: 'repositoryId' } },
});

// The scans list says which repositories were scanned and what each found,
// scoped to the caller's repositories below.
const canReadScans = checkPermissions({
    action: Action.Read,
    resource: ResourceType.SecurityScan,
});

// Same grant as start: the people who can run a scan can unstick one.
// Repo assignment is checked when the scan is loaded (the id is the
// scan, not the repository).
const canCancelScan = checkPermissions({
    action: Action.Create,
    resource: ResourceType.SecurityScan,
});

@ApiTags('Security Scans')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@UseGuards(TenantScopeGuard)
@Controller('security-scans')
export class SecurityScansController {
    constructor(
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly startSecurityScan: StartSecurityScanUseCase,
        private readonly getSecurityScans: GetSecurityScansUseCase,
        private readonly cancelSecurityScan: CancelSecurityScanUseCase,
        private readonly authorizationService: AuthorizationService,
        private readonly deepScanGate: DeepScanGate,
        private readonly schedules: SecurityScanSchedulesUseCase,
    ) {}

    /** The caller's organization, once the deep scan is enabled for it. */
    private async organizationId(): Promise<string> {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException('Organization not found');
        }
        if (!(await this.deepScanGate.isEnabledFor(organizationId))) {
            throw new ForbiddenException(DEEP_SCAN_NOT_ENABLED_MESSAGE);
        }
        return organizationId;
    }

    private visibleRepositories(): Promise<string[] | null> {
        return this.authorizationService.getRepositoryScope({
            user: this.request.user,
            action: Action.Read,
            resource: ResourceType.SecurityScan,
        });
    }

    @Post()
    @ApiOperation({
        summary: 'Start a security scan',
        description:
            "Scans a repository's default branch for security vulnerabilities, within the given spend limit. Findings become Kody Issues.",
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canStartScan)
    async start(@Body() body: StartSecurityScanDto) {
        // On the very repository the scan runs on: the id the use case reads.
        await this.authorizationService.ensure({
            user: this.request.user,
            action: Action.Create,
            resource: ResourceType.SecurityScan,
            repoIds: [body.repositoryId],
        });
        return this.startSecurityScan.execute({
            organizationAndTeamData: {
                organizationId: await this.organizationId(),
                teamId: body.teamId,
            },
            repositoryId: body.repositoryId,
            budget: {
                ...(body.maxUsd !== undefined ? { maxUsd: body.maxUsd } : {}),
                ...(body.maxTokens !== undefined
                    ? { maxTokens: body.maxTokens }
                    : {}),
            },
            requestedBy: {
                userId: this.request.user?.uuid,
                email: this.request.user?.email,
            },
            mode: body.mode,
            modelId: body.modelId,
        });
    }

    @Get()
    @ApiOperation({
        summary: 'List security scans',
        description: 'The most recent scans of the repositories you can see.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadScans)
    async list(@Query('limit') limit?: string) {
        // Only a positive whole number is a limit; anything else (blank,
        // zero, negative, not a number) keeps the default.
        const asked = Number(limit);
        return this.getSecurityScans.list(
            await this.organizationId(),
            (await this.visibleRepositories()) ?? undefined,
            Number.isInteger(asked) && asked > 0 ? asked : undefined,
        );
    }

    @Get('schedules')
    @ApiOperation({
        summary: 'List deep scan schedules',
        description:
            'The schedules of the repositories you can see: cadence, limit, mode, model, next and last run.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadScans)
    async listSchedules() {
        return this.schedules.list(
            await this.organizationId(),
            (await this.visibleRepositories()) ?? undefined,
        );
    }

    @Put('schedules')
    @ApiOperation({
        summary: "Schedule a repository's deep scan",
        description:
            'Creates or replaces the repository schedule: daily or weekly, within a spend limit per run. Incremental by default: each run reads only what changed.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canScheduleScan)
    async saveSchedule(@Body() body: SaveSecurityScanScheduleDto) {
        await this.authorizationService.ensure({
            user: this.request.user,
            action: Action.Create,
            resource: ResourceType.SecurityScan,
            repoIds: [body.repositoryId],
        });
        return this.schedules.save({
            organizationAndTeamData: {
                organizationId: await this.organizationId(),
                teamId: body.teamId,
            },
            repositoryId: body.repositoryId,
            cadence: body.cadence,
            budget: {
                ...(body.maxUsd !== undefined ? { maxUsd: body.maxUsd } : {}),
                ...(body.maxTokens !== undefined
                    ? { maxTokens: body.maxTokens }
                    : {}),
            },
            mode: body.mode,
            modelId: body.modelId,
            enabled: body.enabled,
            requestedBy: {
                userId: this.request.user?.uuid,
                email: this.request.user?.email,
            },
        });
    }

    @Delete('schedules/:repositoryId')
    @ApiOperation({
        summary: "Remove a repository's deep scan schedule",
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canScheduleScan)
    async removeSchedule(
        @Param('repositoryId') repositoryId: string,
        @Query('teamId') teamId: string,
    ) {
        if (!teamId) {
            throw new BadRequestException('teamId is required');
        }
        await this.authorizationService.ensure({
            user: this.request.user,
            action: Action.Create,
            resource: ResourceType.SecurityScan,
            repoIds: [repositoryId],
        });
        return {
            removed: await this.schedules.remove(
                { organizationId: await this.organizationId(), teamId },
                repositoryId,
            ),
        };
    }

    @Post(':id/cancel')
    @ApiOperation({
        summary: 'Cancel a security scan',
        description:
            'Stops a queued or running scan so another can start on the same repository.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canCancelScan)
    async cancel(@Param('id') id: string) {
        const organizationId = await this.organizationId();
        // Loaded within the repositories the caller may scan: one outside
        // them is not found, as on GET /:id.
        const writeRepos = await this.authorizationService.getRepositoryScope({
            user: this.request.user,
            action: Action.Create,
            resource: ResourceType.SecurityScan,
        });
        await this.getSecurityScans.get(
            organizationId,
            id,
            writeRepos ?? undefined,
        );
        return this.cancelSecurityScan.execute({
            organizationId,
            scanId: id,
        });
    }

    @Get(':id')
    @ApiOperation({
        summary: 'Get a security scan',
        description: 'Status, spend, coverage and outcome of one scan.',
    })
    @UseGuards(PolicyGuard)
    @CheckPolicies(canReadScans)
    async get(@Param('id') id: string) {
        return this.getSecurityScans.get(
            await this.organizationId(),
            id,
            (await this.visibleRepositories()) ?? undefined,
        );
    }
}
