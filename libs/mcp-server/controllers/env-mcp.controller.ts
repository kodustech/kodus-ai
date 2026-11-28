import {
    Body,
    Controller,
    Delete,
    Get,
    Post,
    Res,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBody,
    ApiHeader,
    ApiOperation,
    ApiProduces,
    ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';

import { createLogger } from '@libs/core/log/logger';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';

import { McpAuthGuard } from '../guards/mcp-auth.guard';
import { McpEnabledGuard } from '../guards/mcp-enabled.guard';
import { McpEnvTeamKeyGuard } from '../guards/mcp-env-team-key.guard';
import { EnvMcpServerService } from '../services/env-mcp-server.service';
import {
    handleStatelessMcpPost,
    handleUnsupportedStatelessMcpMethod,
} from './mcp-controller.helper';

/**
 * /mcp/env: the Kody Runtime env_* tools for the dev's agent (§4 "MCP e CLI",
 * ADR-057). Its own endpoint so that no other MCP credential reaches them:
 * only a team key, with the exact capability and the repo on its list.
 */
@ApiTags('MCP Env')
@Public()
@Controller('mcp/env')
@UseGuards(McpEnabledGuard, McpAuthGuard, McpEnvTeamKeyGuard)
export class EnvMcpController {
    private readonly logger = createLogger(EnvMcpController.name);

    constructor(private readonly mcp: EnvMcpServerService) {}

    @Post()
    @ApiOperation({
        summary: 'Kody Runtime env tools (MCP)',
        description:
            'Stateless JSON-RPC over Streamable HTTP; team key only (x-team-key or Bearer kodus_…).',
    })
    @ApiHeader({
        name: 'x-team-key',
        required: false,
        description: 'Team key with env:exec and/or env:fix on the repository',
    })
    @ApiProduces('application/json')
    @ApiBody({ schema: { type: 'object', additionalProperties: true } })
    async handle(@Body() body: any, @Res() res: Response) {
        return handleStatelessMcpPost({
            body,
            res,
            handler: this.mcp.handleRequest.bind(this.mcp),
            errorContext: EnvMcpController.name,
            errorMessage: 'Error handling MCP env request',
            logger: this.logger,
        });
    }

    @Get()
    @ApiOperation({ summary: 'GET is not supported on /mcp/env' })
    get(@Res() res: Response) {
        return handleUnsupportedStatelessMcpMethod(res);
    }

    @Delete()
    @ApiOperation({ summary: 'DELETE is not supported on /mcp/env' })
    delete(@Res() res: Response) {
        return handleUnsupportedStatelessMcpMethod(res);
    }
}
