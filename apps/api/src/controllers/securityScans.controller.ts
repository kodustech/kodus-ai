import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Inject,
    Param,
    Post,
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
}

// A scan spends the organization's model budget on one repository.
const canStartScan = checkRepoPermissions({
    action: Action.Create,
    resource: ResourceType.SecurityScan,
    repo: { key: { body: 'repositoryId' } },
});

// The scans list says which repositories were scanned and what each found,
// scoped to the caller's repositories below.
const canReadScans = checkPermissions({
    action: Action.Read,
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
        private readonly authorizationService: AuthorizationService,
    ) {}

    private organizationId(): string {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new BadRequestException('Organization not found');
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
        return this.startSecurityScan.execute({
            organizationAndTeamData: {
                organizationId: this.organizationId(),
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
        return this.getSecurityScans.list(
            this.organizationId(),
            (await this.visibleRepositories()) ?? undefined,
            limit ? Number(limit) : undefined,
        );
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
            this.organizationId(),
            id,
            (await this.visibleRepositories()) ?? undefined,
        );
    }
}
