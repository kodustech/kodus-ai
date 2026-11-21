import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import type { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkRole } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import {
    CreateRuntimeSecretUseCase,
    DeleteRuntimeSecretUseCase,
    ListRuntimeSecretAuditUseCase,
    ListRuntimeSecretsUseCase,
    UpdateRuntimeSecretUseCase,
} from '@libs/runtime/api/application/use-cases/secrets.use-cases';

import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import { CreateRuntimeSecretDto, UpdateRuntimeSecretDto } from './runtime-secrets.dto';
import { RuntimeReleaseGuard } from './runtime-release.guard';

/**
 * The org admin's Runtime secrets (docs/runtime/sandbox.md "Secrets: OpenBao"):
 * credentials a machine uses outward, each bound to its exact hosts. The value
 * is write-only and never enters a machine; every change is audited.
 */
@ApiTags('Kody Runtime')
@ApiStandardResponses()
@ApiBearerAuth('jwt')
@Controller('runtime/secrets')
@UseGuards(RuntimeReleaseGuard, PolicyGuard)
export class RuntimeSecretsController {
    constructor(
        private readonly listSecrets: ListRuntimeSecretsUseCase,
        private readonly createSecret: CreateRuntimeSecretUseCase,
        private readonly updateSecret: UpdateRuntimeSecretUseCase,
        private readonly deleteSecret: DeleteRuntimeSecretUseCase,
        private readonly listAudit: ListRuntimeSecretAuditUseCase,
    ) {}

    @Get()
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'List Runtime secrets', description: 'Name, hosts, who changed it and when. Never a value.' })
    list(@Req() req: UserRequest) {
        return this.listSecrets.execute({ user: req.user });
    }

    @Get('audit')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Runtime secret changes', description: 'Every create, update and delete, newest first.' })
    @ApiQuery({ name: 'limit', required: false, description: '1 to 200, 50 by default' })
    audit(@Req() req: UserRequest, @Query('limit') limit?: string) {
        return this.listAudit.execute({ user: req.user, limit });
    }

    @Post()
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Create a Runtime secret', description: 'The value goes to the secret store only and is never returned.' })
    create(@Req() req: UserRequest, @Body() body: CreateRuntimeSecretDto) {
        return this.createSecret.execute({ user: req.user, body: { name: body.name, hosts: body.hosts, value: body.value } });
    }

    @Patch(':secretId')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Update a Runtime secret', description: 'New hosts, a new value, or both.' })
    update(@Req() req: UserRequest, @Param('secretId') secretId: string, @Body() body: UpdateRuntimeSecretDto) {
        return this.updateSecret.execute({ user: req.user, secretId, body: { hosts: body.hosts, value: body.value } });
    }

    @Delete(':secretId')
    @HttpCode(204)
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Delete a Runtime secret', description: 'Every version leaves the store; machines stop receiving it at once.' })
    async remove(@Req() req: UserRequest, @Param('secretId') secretId: string) {
        await this.deleteSecret.execute({ user: req.user, secretId });
    }
}
