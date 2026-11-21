import { Body, Controller, Get, Param, Patch, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import type { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Action, ResourceType, Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions, checkRole } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import {
    GetRuntimeMachineMinutesUseCase,
    GetRuntimeSettingsUseCase,
    UpdateRuntimeMachineMinutesUseCase,
    UpdateRuntimeOrgSettingsUseCase,
    UpdateRuntimeRepositorySettingsUseCase,
} from '@libs/runtime/api/application/use-cases/settings.use-cases';
import { GetRuntimeHealthUseCase } from '@libs/runtime/api/application/use-cases/runtime-health.use-case';
import { GetRuntimeSpeedUseCase } from '@libs/runtime/api/application/use-cases/runtime-speed.use-case';
import { GetRuntimeUsageReportUseCase } from '@libs/runtime/api/application/use-cases/usage-report.use-case';
import { RuntimePreviewSettingsUseCase } from '@libs/runtime/api/application/use-cases/preview-settings.use-cases';

import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import { UpdateRepositoryRuntimeSettingsDto, UpdateRuntimeMachineMinutesDto, UpdateRuntimeOrgSettingsDto } from './runtime.dto';
import { RuntimeReleaseGuard } from './runtime-release.guard';

/** Kody Runtime settings (§7), in the product Postgres: the org budget, the exercised-lines threshold, the price of the org's own host and each repository's trigger settings. */
@ApiTags('Kody Runtime')
@ApiStandardResponses()
@ApiBearerAuth('jwt')
@Controller('runtime/settings')
@UseGuards(RuntimeReleaseGuard, PolicyGuard)
export class RuntimeSettingsController {
    constructor(
        private readonly getSettingsUseCase: GetRuntimeSettingsUseCase,
        private readonly updateOrgSettingsUseCase: UpdateRuntimeOrgSettingsUseCase,
        private readonly updateRepositorySettingsUseCase: UpdateRuntimeRepositorySettingsUseCase,
        private readonly getMachineMinutesUseCase: GetRuntimeMachineMinutesUseCase,
        private readonly updateMachineMinutesUseCase: UpdateRuntimeMachineMinutesUseCase,
        private readonly getUsageReportUseCase: GetRuntimeUsageReportUseCase,
        private readonly getHealthUseCase: GetRuntimeHealthUseCase,
        private readonly getSpeedUseCase: GetRuntimeSpeedUseCase,
        private readonly previewSettings: RuntimePreviewSettingsUseCase,
    ) {}

    @Get('preview')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Get preview settings', description: "Previews on or off, pull requests from forks, the idle stop, one start's ceiling and the monthly cap; whether this deployment serves previews, and this month's preview time. Owner only." })
    getPreviewSettings(@Req() req: UserRequest) {
        return this.previewSettings.get({ user: req.user });
    }

    @Put('preview')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Update preview settings', description: 'Every field at once: { enabled, forks, idleMinutes, ceilingMinutes, monthlyMachineMinutes }. Owner only.' })
    updatePreviewSettings(@Req() req: UserRequest, @Body() body: Record<string, unknown>) {
        return this.previewSettings.update({ user: req.user, body });
    }

    @Get()
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.CodeReviewSettings }))
    @ApiOperation({ summary: 'Get Runtime settings', description: 'Daily token budget and the per-repository settings.' })
    getSettings(@Req() req: UserRequest) {
        return this.getSettingsUseCase.execute({ user: req.user });
    }

    @Get('machine-minutes')
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.CodeReviewSettings }))
    @ApiOperation({ summary: 'Get Runtime machine minutes of today', description: 'Machine minutes the org used and committed today (UTC), its daily limit and when it resets.' })
    getMachineMinutes(@Req() req: UserRequest) {
        return this.getMachineMinutesUseCase.execute({ user: req.user });
    }

    @Patch('machine-minutes')
    @CheckPolicies(checkPermissions({ action: Action.Update, resource: ResourceType.OrganizationSettings }))
    @ApiOperation({
        summary: "Set the org's own daily machine minutes",
        description: "Lowers the deployment's daily machine minutes for the org (never raises them); null goes back to the deployment's. The hub applies it from the next claim round.",
    })
    updateMachineMinutes(@Req() req: UserRequest, @Body() body: UpdateRuntimeMachineMinutesDto) {
        return this.updateMachineMinutesUseCase.execute({ user: req.user, body: { minutesPerDay: body.minutesPerDay } });
    }

    @Get('usage')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({
        summary: 'Get the Runtime usage report',
        description: "What the org's Runs, setups and sandbox sessions used in one UTC month: counts, wall time, machine time, LLM tokens and US$, and each Run. Owner only.",
    })
    @ApiQuery({ name: 'month', required: false, description: 'YYYY-MM (UTC); the current month by default' })
    @ApiQuery({ name: 'repositoryId', required: false })
    @ApiQuery({ name: 'environmentId', required: false })
    getUsage(@Req() req: UserRequest, @Query('month') month?: string, @Query('repositoryId') repositoryId?: string, @Query('environmentId') environmentId?: string) {
        return this.getUsageReportUseCase.execute({ user: req.user, query: { month, repositoryId, environmentId } });
    }

    @Get('health')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({
        summary: 'Get the Runtime health',
        description: "Setups and Runs, boot times, what is stuck past its bound, errors by blocker signature, the org's own cells and today's cost. Owner only.",
    })
    getHealth(@Req() req: UserRequest) {
        return this.getHealthUseCase.execute({ user: req.user });
    }

    @Get('health/speed')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({
        summary: 'Get the Runtime speed',
        description:
            'p50/p95 of request to verdict, request to both sides ready (first probe executed) and queue wait over the window, by machine source, host and environment. Cancelled, superseded and verdict-less Runs are left out and counted. Owner only.',
    })
    @ApiQuery({ name: 'windowDays', required: false, description: '7 (default) or 30' })
    getSpeed(@Req() req: UserRequest, @Query('windowDays') windowDays?: string) {
        return this.getSpeedUseCase.execute({ user: req.user, windowDays });
    }

    @Get('usage/export')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Export the Runtime usage report as CSV', description: 'One line per Run of the month, the same filters as the report. Owner only.' })
    @ApiQuery({ name: 'month', required: false, description: 'YYYY-MM (UTC); the current month by default' })
    @ApiQuery({ name: 'repositoryId', required: false })
    @ApiQuery({ name: 'environmentId', required: false })
    async exportUsage(
        @Req() req: UserRequest,
        @Res() res: Response,
        @Query('month') month?: string,
        @Query('repositoryId') repositoryId?: string,
        @Query('environmentId') environmentId?: string,
    ) {
        const { filename, body } = await this.getUsageReportUseCase.csv({ user: req.user, query: { month, repositoryId, environmentId } });
        res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
        return res.send(body);
    }

    @Patch()
    @CheckPolicies(checkPermissions({ action: Action.Update, resource: ResourceType.OrganizationSettings }))
    @ApiOperation({
        summary: 'Update Runtime settings',
        description:
            "The org's daily token budget, exercised-lines threshold and price per host-hour of its own hosts; a field left out is kept. A Run already asked keeps the threshold it started with.",
    })
    updateOrgSettings(@Req() req: UserRequest, @Body() body: UpdateRuntimeOrgSettingsDto) {
        return this.updateOrgSettingsUseCase.execute({ user: req.user, body: definedFields(body) });
    }

    @Put('repositories/:repositoryId')
    @CheckPolicies(checkPermissions({ action: Action.Update, resource: ResourceType.CodeReviewSettings }))
    @ApiOperation({ summary: 'Update repository Runtime settings', description: 'Leaving off creates the environment.' })
    updateRepositorySettings(@Req() req: UserRequest, @Param('repositoryId') repositoryId: string, @Body() body: UpdateRepositoryRuntimeSettingsDto) {
        return this.updateRepositorySettingsUseCase.execute({ user: req.user, repositoryId, body: definedFields(body) });
    }
}

/** The DTO instance without the fields the caller left out: the use case reads "absent" as "keep". */
function definedFields<T extends object>(dto: T): Partial<T> {
    return Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined)) as Partial<T>;
}
