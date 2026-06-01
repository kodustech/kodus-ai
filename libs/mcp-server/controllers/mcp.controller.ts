import {
    Controller,
    Post,
    Get,
    Delete,
    Body,
    Res,
    UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import {
    ApiBody,
    ApiHeader,
    ApiOperation,
    ApiProduces,
    ApiTags,
} from '@nestjs/swagger';
import { McpServerService } from '../services/mcp-server.service';
import { McpEnabledGuard } from '../guards/mcp-enabled.guard';
import { createLogger } from '@kodus/flow';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import {
    handleStatelessMcpPost,
    handleUnsupportedStatelessMcpMethod,
} from './mcp-controller.helper';

@ApiTags('MCP')
@Public()
@Controller('mcp')
@UseGuards(McpEnabledGuard)
export class McpController {
    private readonly logger = createLogger(McpController.name);

    constructor(private readonly mcpServerService: McpServerService) {}

    @Post()
    @ApiOperation({
        summary: 'Handle MCP client request',
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
            description: 'JSON-RPC request payload (MCP protocol).',
            additionalProperties: true,
            example: {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'local', version: '1.0.0' },
                },
            },
        },
    })
    async handleClientRequest(@Body() body: any, @Res() res: Response) {
        return handleStatelessMcpPost({
            body,
            res,
            handler: this.mcpServerService.handleRequest.bind(
                this.mcpServerService,
            ),
            errorContext: McpController.name,
            errorMessage: 'Error handling MCP request',
            logger: this.logger,
        });
    }

    @Get()
    @ApiOperation({
        summary: 'GET is not supported for this MCP endpoint',
        description:
            'This deployment runs MCP in stateless POST-only mode. Long-lived SSE streams are not exposed on this endpoint.',
    })
    @ApiProduces('text/event-stream')
    async handleServerNotifications(@Res() res: Response) {
        return handleUnsupportedStatelessMcpMethod(res);
    }

    @Delete()
    @ApiOperation({
        summary: 'DELETE is not supported for this MCP endpoint',
        description:
            'This deployment does not keep MCP sessions between requests, so there is no session to terminate.',
    })
    async handleSessionTermination(@Res() res: Response) {
        return handleUnsupportedStatelessMcpMethod(res);
    }
}
