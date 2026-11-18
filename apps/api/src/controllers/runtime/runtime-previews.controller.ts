import { Body, Controller, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import type { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { CheckPolicies, PolicyGuard } from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { RuntimePreviewsService } from '@libs/runtime/api/application/use-cases/previews.use-cases';

import { ApiStandardResponses } from '../../docs/api-standard-responses.decorator';
import { OpenRuntimePreviewDto, RuntimePreviewGrantDto } from './runtime.dto';
import { RuntimeReleaseGuard } from './runtime-release.guard';

/**
 * Kody Runtime preview URLs (docs/runtime/preview-urls.md §9.3). The guard
 * checks the role has RuntimePreview read at all; the use case loads the Run
 * behind the preview and checks the repo scope of every repository of its
 * environment (repo-scoped for every role but owner). A preview or Run of
 * another org answers 404.
 */
@ApiTags('Kody Runtime')
@ApiStandardResponses()
@Controller('runtime')
@UseGuards(RuntimeReleaseGuard)
export class RuntimePreviewsController {
    constructor(private readonly previews: RuntimePreviewsService) {}

    @Post('runs/:runId/previews')
    @HttpCode(200)
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimePreview }))
    @ApiOperation({ summary: 'Open a Run preview', description: 'Boots one side of a finished Run on its own machines, on demand; answers the preview and its state.' })
    open(@Req() req: UserRequest, @Param('runId') runId: string, @Body() body: OpenRuntimePreviewDto) {
        return this.previews.open(req.user, runId, body.side);
    }

    @Get('runs/:runId/previews')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimePreview }))
    @ApiOperation({ summary: "Get a Run's previews", description: 'Whether each side can open (and why not), and the preview of each side once opened.' })
    forRun(@Req() req: UserRequest, @Res({ passthrough: true }) res: Response, @Param('runId') runId: string) {
        res.setHeader('Cache-Control', 'private, no-store');
        return this.previews.forRun(req.user, runId);
    }

    @Get('environments/:environmentId/previews')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimePreview }))
    @ApiOperation({ summary: "Get an environment's preview", description: 'Its base side at the commit the last setup baked: whether it can open, and its state once opened.' })
    forEnvironment(@Req() req: UserRequest, @Res({ passthrough: true }) res: Response, @Param('environmentId') environmentId: string) {
        res.setHeader('Cache-Control', 'private, no-store');
        return this.previews.forEnvironment(req.user, environmentId);
    }

    @Post('environments/:environmentId/previews')
    @HttpCode(200)
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimePreview }))
    @ApiOperation({ summary: 'Open an environment preview', description: 'Boots the environment at its last setup on its own machines, on demand.' })
    openEnvironment(@Req() req: UserRequest, @Param('environmentId') environmentId: string) {
        return this.previews.openEnvironment(req.user, environmentId);
    }

    @Get('previews/:previewId')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimePreview }))
    @ApiOperation({ summary: 'Get a Run preview', description: 'State, host and reason of one preview.' })
    get(@Req() req: UserRequest, @Res({ passthrough: true }) res: Response, @Param('previewId') previewId: string) {
        res.setHeader('Cache-Control', 'private, no-store');
        return this.previews.get(req.user, previewId);
    }

    @Post('previews/:previewId/grant')
    @HttpCode(200)
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimePreview }))
    @ApiOperation({ summary: 'Grant a preview session', description: 'A single-use, 60-second grant for the preview host, inside the URL to send the browser to.' })
    grant(@Req() req: UserRequest, @Res({ passthrough: true }) res: Response, @Param('previewId') previewId: string, @Body() body: RuntimePreviewGrantDto) {
        res.setHeader('Cache-Control', 'private, no-store');
        return this.previews.grant(req.user, previewId, body?.to);
    }

    @Post('previews/:previewId/stop')
    @HttpCode(200)
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    // The opener, or a role that manages previews (owner): checked in the use case.
    @CheckPolicies(checkPermissions({ action: Action.Read, resource: ResourceType.RuntimePreview }))
    @ApiOperation({ summary: 'Stop a Run preview', description: 'Releases its machines and ends its sessions.' })
    stop(@Req() req: UserRequest, @Param('previewId') previewId: string) {
        return this.previews.stop(req.user, previewId);
    }
}
