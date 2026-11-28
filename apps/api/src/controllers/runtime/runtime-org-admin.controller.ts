import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import type { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Action, ResourceType, Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions, checkRole } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { ApproveEgressUseCase } from '@libs/runtime/api/application/use-cases/approve-egress.use-case';
import { OrgEgressUseCases, RevokeEgressUseCase } from '@libs/runtime/api/application/use-cases/egress-access.use-cases';
import {
    CreateCellRegistrationTokenUseCase,
    ListCellRegistrationTokensUseCase,
    ListRuntimeCellsUseCase,
    RevokeCellRegistrationTokenUseCase,
    RevokeRuntimeCellUseCase,
} from '@libs/runtime/api/application/use-cases/cells.use-cases';
import { PurgeRuntimeOrganizationUseCase } from '@libs/runtime/api/application/use-cases/purge-organization.use-case';
import { ClearRuntimeStopUseCase, StopRuntimeUseCase } from '@libs/runtime/api/application/use-cases/stop-runtime.use-case';

import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import { ApproveEgressHostDto, CreateCellRegistrationTokenDto, OrgEgressSettingsDto, OrgRuntimeStopDto, PurgeOrganizationDataDto, RevokeCellDto, RevokeEgressHostDto } from './runtime.dto';
import { RuntimeReleaseGuard } from './runtime-release.guard';

/**
 * The org admin's Runtime controls (§7): egress approvals, the org's stop
 * button, the org's cells. Everything here acts on the caller's own org;
 * the global stop and the managed fleet are RuntimeOpsController's.
 */
@ApiTags('Kody Runtime')
@ApiStandardResponses()
@ApiBearerAuth('jwt')
@Controller('runtime')
@UseGuards(RuntimeReleaseGuard, PolicyGuard)
export class RuntimeOrgAdminController {
    constructor(
        private readonly approveEgress: ApproveEgressUseCase,
        private readonly revokeEgress: RevokeEgressUseCase,
        private readonly orgEgress: OrgEgressUseCases,
        private readonly stopRuntime: StopRuntimeUseCase,
        private readonly clearStop: ClearRuntimeStopUseCase,
        private readonly createCellToken: CreateCellRegistrationTokenUseCase,
        private readonly listCellsUseCase: ListRuntimeCellsUseCase,
        private readonly revokeCellUseCase: RevokeRuntimeCellUseCase,
        private readonly listCellTokens: ListCellRegistrationTokensUseCase,
        private readonly revokeCellToken: RevokeCellRegistrationTokenUseCase,
        private readonly purgeOrganizationData: PurgeRuntimeOrganizationUseCase,
    ) {}

    // Owners and repo admins (Update on CodeReviewSettings, as creating an environment); the use case then applies
    // the org's who-may-add setting to a repo admin (D3, RuntimeEgressAccess).
    @Post('environments/:id/egress-approvals')
    @HttpCode(202)
    @CheckPolicies(checkPermissions({ action: Action.Update, resource: ResourceType.CodeReviewSettings }))
    @ApiOperation({
        summary: 'Approve an egress domain',
        description: "One domain for one environment, or the org list (id '*', owners only). Inspected by default (GET/HEAD under pathPrefixes); mode passthrough is full access. The Kodus denylist is refused.",
    })
    approveEgressHost(@Req() req: UserRequest, @Param('id') id: string, @Body() body: ApproveEgressHostDto) {
        return this.approveEgress.execute({
            user: req.user, environmentId: id, host: body.host, mode: body.mode, pathPrefixes: body.pathPrefixes,
            source: body.source, sourceRef: body.sourceRef, reason: body.reason,
        });
    }

    @Delete('environments/:id/egress-approvals/:host')
    @HttpCode(202)
    @CheckPolicies(checkPermissions({ action: Action.Update, resource: ResourceType.CodeReviewSettings }))
    @ApiOperation({ summary: 'Revoke an egress approval', description: "The environment's (or the org list's, id '*') live claims lose the host at once." })
    revokeEgressHost(@Req() req: UserRequest, @Param('id') id: string, @Param('host') host: string, @Body() body: RevokeEgressHostDto) {
        return this.revokeEgress.execute({ user: req.user, environmentId: id, host, reason: body?.reason });
    }

    // Every environment reader (the settings screen shows it to them); changes are the owner's.
    @Get('egress')
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimeEnvironment }))
    @ApiOperation({ summary: "The org's outbound access", description: 'The Kodus recommended list, the org list, who may add hosts and the audit.' })
    getOrgEgress(@Req() req: UserRequest) {
        return this.orgEgress.get(req.user);
    }

    @Put('egress/settings')
    @HttpCode(202)
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: "Change the org's outbound access settings", description: 'The recommended list on or off (D2) and who may add hosts to an environment (D3).' })
    updateOrgEgressSettings(@Req() req: UserRequest, @Body() body: OrgEgressSettingsDto) {
        return this.orgEgress.update(req.user, body);
    }

    @Post('stop')
    @HttpCode(202)
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Stop the Runtime for the org', description: "scope 'org' only; the global stop is not a tenant route." })
    stopOrgRuntime(@Req() req: UserRequest, @Body() body: OrgRuntimeStopDto) {
        return this.stopRuntime.execute({ user: req.user, scope: body.scope });
    }

    @Post('stop/clear')
    @HttpCode(202)
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Clear the org stop', description: "Reopens the Runtime for the org; scope 'org' only." })
    clearOrgRuntimeStop(@Req() req: UserRequest, @Body() body: OrgRuntimeStopDto) {
        return this.clearStop.execute({ user: req.user, scope: body.scope });
    }

    @Post('cells/registration-tokens')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Create a cell registration token', description: 'Single use, 15 minutes, bound to the org and topology.' })
    createCellRegistrationToken(@Req() req: UserRequest, @Body() body: CreateCellRegistrationTokenDto) {
        return this.createCellToken.execute({ user: req.user, topology: body.topology });
    }

    @Get('cells/registration-tokens')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'List cell registration tokens', description: 'The org tokens of the last 24 h with their state; never the token itself.' })
    listCellRegistrationTokens(@Req() req: UserRequest) {
        return this.listCellTokens.execute({ user: req.user });
    }

    @Post('cells/registration-tokens/:id/revoke')
    @HttpCode(202)
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Revoke a cell registration token', description: 'A pending token of the org; a used, expired or revoked one is 409.' })
    revokeCellRegistrationToken(@Req() req: UserRequest, @Param('id') id: string) {
        return this.revokeCellToken.execute({ user: req.user, id });
    }

    @Get('cells')
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'List cells', description: 'Cells of the org with their status.' })
    listCells(@Req() req: UserRequest) {
        return this.listCellsUseCase.execute({ user: req.user });
    }

    @Post('cells/:id/revoke')
    @HttpCode(202)
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({ summary: 'Revoke a cell', description: "A cell of the caller's org; another org's cell is 404." })
    revokeCell(@Req() req: UserRequest, @Param('id') id: string, @Body() body: RevokeCellDto) {
        return this.revokeCellUseCase.execute({ user: req.user, cellId: id, reason: body.reason, scope: 'org' });
    }

    @Post('organization-data/purge')
    @HttpCode(202)
    @CheckPolicies(checkRole({ role: Role.OWNER }))
    @ApiOperation({
        summary: "Delete every Runtime datum of the org",
        description:
            "Irreversible. The org's Runtime secrets leave the secret store, its product rows are deleted, and the Runtime cancels its live Runs and deletes its Runs, evidence and every other row. The body's confirm must be the org id.",
    })
    purgeOrganizationRuntimeData(@Req() req: UserRequest, @Body() body: PurgeOrganizationDataDto) {
        return this.purgeOrganizationData.executeConfirmed({ user: req.user, confirm: body.confirm });
    }
}
