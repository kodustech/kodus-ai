import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';

import type { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkRole } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { ListRuntimeAuditUseCase } from '@libs/runtime/api/application/use-cases/env-audit.use-case';

import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import { RuntimeReleaseGuard } from './runtime-release.guard';

/** The org admin's audit of what team keys ran in Runtime environments (§7, S-27). */
@ApiTags('Kody Runtime')
@ApiStandardResponses()
@ApiBearerAuth('jwt')
@Controller('runtime')
@UseGuards(RuntimeReleaseGuard, PolicyGuard)
export class RuntimeAuditController {
    constructor(private readonly listAudit: ListRuntimeAuditUseCase) {}

    @Get('audit')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({
        summary: 'Runtime audit',
        description: 'Every env_exec (or env_fix) of the org team keys: key, repo, command (redacted), when; or, with kind=preview, every preview session, start, wake, sleep, stop and expiry. Newest first.',
    })
    @ApiQuery({ name: 'kind', required: true, enum: ['env_exec', 'env_fix', 'preview'] })
    @ApiQuery({ name: 'previewId', required: false, description: 'kind=preview: one preview only' })
    @ApiQuery({ name: 'limit', required: false, description: '1 to 200, 50 by default' })
    @ApiQuery({ name: 'before', required: false, description: 'ISO date: records before it (the next page)' })
    list(@Req() req: UserRequest, @Query('kind') kind: string, @Query('limit') limit?: string, @Query('before') before?: string, @Query('previewId') previewId?: string) {
        return this.listAudit.execute({ user: req.user, kind, limit, before, previewId });
    }
}
