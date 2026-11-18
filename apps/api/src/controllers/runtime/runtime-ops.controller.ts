import { Body, Controller, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import type { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkRole } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { RevokeRuntimeCellUseCase } from '@libs/runtime/api/application/use-cases/cells.use-cases';
import { ClearRuntimeStopUseCase, StopRuntimeUseCase } from '@libs/runtime/api/application/use-cases/stop-runtime.use-case';

import { RevokeCellDto } from './runtime.dto';
import { RuntimeOncallGuard } from './runtime-oncall.guard';

/**
 * Kodus operator controls of the Runtime (§7): the global stop and the
 * managed fleet. Off the tenant surface: under /internal, hidden from the
 * API docs, and 404 to anyone who is not the Kodus on-call. Every call is
 * still written to the outbox with the on-call user as `requestedBy`.
 */
@ApiExcludeController()
@Controller('internal/runtime/ops')
@UseGuards(RuntimeOncallGuard, PolicyGuard)
export class RuntimeOpsController {
    constructor(
        private readonly stopRuntime: StopRuntimeUseCase,
        private readonly clearStop: ClearRuntimeStopUseCase,
        private readonly revokeCellUseCase: RevokeRuntimeCellUseCase,
    ) {}

    @Post('stop')
    @HttpCode(202)
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    stopRuntimeGlobally(@Req() req: UserRequest) {
        return this.stopRuntime.execute({ user: req.user, scope: 'global' });
    }

    @Post('stop/clear')
    @HttpCode(202)
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    clearGlobalRuntimeStop(@Req() req: UserRequest) {
        return this.clearStop.execute({ user: req.user, scope: 'global' });
    }

    @Post('cells/:id/revoke')
    @HttpCode(202)
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    revokeManagedCell(@Req() req: UserRequest, @Param('id') id: string, @Body() body: RevokeCellDto) {
        return this.revokeCellUseCase.execute({ user: req.user, cellId: id, reason: body.reason, scope: 'ops' });
    }
}
