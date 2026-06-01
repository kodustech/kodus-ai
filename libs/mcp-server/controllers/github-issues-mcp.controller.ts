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

import { createLogger } from '@kodus/flow';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { McpEnabledGuard } from '../guards/mcp-enabled.guard';
import { GithubIssuesMcpServerService } from '../services/github-issues-mcp-server.service';
import {
    handleStatelessMcpPost,
    handleUnsupportedStatelessMcpMethod,
} from './mcp-controller.helper';

@ApiTags('MCP Github Issues')
@Public()
@Controller('mcp/github-issues')
@UseGuards(McpEnabledGuard)
export class GithubIssuesMcpController {
    private readonly logger = createLogger(GithubIssuesMcpController.name);

    constructor(
        private readonly mcpServerService: GithubIssuesMcpServerService,
    ) {}

    @Post()
    @ApiOperation({
        summary: 'Handle GitHub Issues MCP client request',
        description:
            'Handles JSON-RPC MCP client requests over stateless Streamable HTTP. Each POST request creates a fresh MCP server and transport for the lifetime of that request only.',
    })
    @ApiHeader({
        name: 'accept',
        required: true,
        description:
            'Clients should advertise `application/json, text/event-stream` per Streamable HTTP negotiation.',
    })
    @ApiProduces('application/json', 'text/event-stream')
    @ApiBody({
        schema: {
            type: 'object',
            additionalProperties: true,
        },
    })
    async handleClientRequest(@Body() body: any, @Res() res: Response) {
        return handleStatelessMcpPost({
            body,
            res,
            handler: this.mcpServerService.handleRequest.bind(
                this.mcpServerService,
            ),
            errorContext: GithubIssuesMcpController.name,
            errorMessage: 'Error handling GitHub Issues MCP request',
            logger: this.logger,
        });
    }

    @Get()
    @ApiOperation({
        summary: 'GET is not supported for this GitHub Issues MCP endpoint',
        description:
            'This deployment runs MCP in stateless POST-only mode. Long-lived SSE streams are not exposed on this endpoint.',
    })
    @ApiProduces('text/event-stream')
    async handleServerNotifications(@Res() res: Response) {
        return handleUnsupportedStatelessMcpMethod(res);
    }

    @Delete()
    @ApiOperation({
        summary: 'DELETE is not supported for this GitHub Issues MCP endpoint',
        description:
            'This deployment does not keep MCP sessions between requests, so there is no session to terminate.',
    })
    async handleSessionTermination(@Res() res: Response) {
        return handleUnsupportedStatelessMcpMethod(res);
    }
}
