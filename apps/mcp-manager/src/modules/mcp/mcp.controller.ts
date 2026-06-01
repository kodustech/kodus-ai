import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Put,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiBody,
    ApiCreatedResponse,
    ApiExtraModels,
    ApiForbiddenResponse,
    ApiInternalServerErrorResponse,
    ApiNotFoundResponse,
    ApiOkResponse,
    ApiOperation,
    ApiParam,
    ApiQuery,
    ApiTags,
    ApiUnauthorizedResponse,
    getSchemaPath,
} from '@nestjs/swagger';
import { ErrorResponseDto } from '../../common/dto';
import { AuthGuard } from '../../common/guards/auth.guard';
import { CreateIntegrationDto } from './dto/create-integration.dto';
import { FinishOAuthDto } from './dto/finish-oauth.dto';
import { InitiateConnectionDto } from './dto/initiate-connection.dto';
import { InitiateOAuthDto } from './dto/initiate-oauth.dto';
import {
    McpAllowedToolsResponseDto,
    McpConnectionDto,
    McpConnectionsResponseDto,
    McpIntegrationDetailsDto,
    McpIntegrationDto,
    McpKodusIntegrationResponseDto,
    McpMessageResponseDto,
    McpOAuthInitResponseDto,
    McpRequiredParamDto,
    McpToolDto,
} from './dto/mcp-responses.dto';
import { QueryDto } from './dto/query.dto';
import {
    UpdateAllowedToolsDto,
    UpdateConnectionDto,
} from './dto/update-connection.dto';
import { McpService } from './mcp.service';

@Controller('mcp')
@ApiTags('MCP')
@ApiBearerAuth()
@ApiExtraModels(McpIntegrationDto, McpKodusIntegrationResponseDto)
@UseGuards(AuthGuard)
export class McpController {
    constructor(private readonly mcpService: McpService) {}

    @Get('connections')
    @ApiOperation({
        summary: 'List connections',
        description: 'Lists MCP connections for the organization.',
    })
    @ApiOkResponse({ type: McpConnectionsResponseDto })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
    @ApiQuery({
        name: 'pageSize',
        required: false,
        type: Number,
        example: 50,
    })
    @ApiQuery({
        name: 'provider',
        required: false,
        type: String,
        example: 'composio',
    })
    @ApiQuery({
        name: 'appName',
        required: false,
        type: String,
        example: 'GitHub',
    })
    @ApiQuery({
        name: 'integrationId',
        required: false,
        type: String,
        example: 'int_456',
    })
    @ApiQuery({
        name: 'status',
        required: false,
        type: String,
        example: 'ACTIVE',
    })
    getConnections(@Query() query: QueryDto, @Req() request: FastifyRequest) {
        return this.mcpService.getConnections(query, request.organizationId);
    }

    @Get('connections/:connectionId')
    @ApiOperation({
        summary: 'Get connection',
        description: 'Returns a connection by ID.',
    })
    @ApiOkResponse({
        type: McpConnectionDto,
        description: 'Returns the connection or null if not found.',
    })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'connectionId',
        type: String,
        example: 'b6f7c3b8-2b1e-4c54-9e6a-0baf7a6a9e3a',
    })
    async getConnection(
        @Param('connectionId') connectionId: string,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.getConnection(
            connectionId,
            request.organizationId,
        );
    }

    @Patch('connections')
    @ApiOperation({
        summary: 'Update connection',
        description: 'Updates connection status or metadata by integration ID.',
    })
    @ApiOkResponse({ type: McpConnectionDto })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiNotFoundResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiBody({ type: UpdateConnectionDto })
    updateConnection(
        @Body() body: UpdateConnectionDto,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.updateConnection(body, request.organizationId);
    }

    @Delete('connections/:connectionId')
    @ApiOperation({
        summary: 'Delete connection',
        description: 'Deletes a connection by ID.',
    })
    @ApiOkResponse({ type: McpMessageResponseDto })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiNotFoundResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'connectionId',
        type: String,
        example: 'b6f7c3b8-2b1e-4c54-9e6a-0baf7a6a9e3a',
    })
    deleteConnection(
        @Param('connectionId') connectionId: string,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.deleteConnection(
            connectionId,
            request.organizationId,
        );
    }

    @Put('connections/:integrationId/allowed-tools')
    @ApiOperation({
        summary: 'Update allowed tools',
        description: 'Updates the allowed tools for a connection.',
    })
    @ApiOkResponse({ type: McpAllowedToolsResponseDto })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiNotFoundResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'integrationId',
        type: String,
        example: 'int_456',
    })
    @ApiBody({ type: UpdateAllowedToolsDto })
    updateAllowedTools(
        @Param('integrationId') integrationId: string,
        @Body() body: UpdateAllowedToolsDto,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.updateAllowedTools(
            integrationId,
            body.allowedTools,
            request.organizationId,
        );
    }

    @Get('integrations')
    @ApiOperation({
        summary: 'List integrations',
        description: 'Lists available integrations across providers.',
    })
    @ApiOkResponse({ type: [McpIntegrationDto] })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
    @ApiQuery({
        name: 'pageSize',
        required: false,
        type: Number,
        example: 50,
    })
    @ApiQuery({
        name: 'appName',
        required: false,
        type: String,
        example: 'GitHub',
    })
    getIntegrations(@Query() query: QueryDto, @Req() request: FastifyRequest) {
        return this.mcpService.getIntegrations(query, request.organizationId);
    }

    @Get(':provider/integrations/:integrationId')
    @ApiOperation({
        summary: 'Get integration',
        description: 'Returns integration details for a provider.',
    })
    @ApiOkResponse({ type: McpIntegrationDetailsDto })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'provider',
        type: String,
        example: 'composio',
    })
    @ApiParam({
        name: 'integrationId',
        type: String,
        example: 'int_456',
    })
    getIntegration(
        @Param('integrationId') integrationId: string,
        @Param('provider') provider: string,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.getIntegration(
            integrationId,
            provider,
            request.organizationId,
        );
    }

    @Get(':provider/integrations/:integrationId/required-params')
    @ApiOperation({
        summary: 'Get required params',
        description: 'Returns required parameters for an integration.',
    })
    @ApiOkResponse({ type: [McpRequiredParamDto] })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'provider',
        type: String,
        example: 'composio',
    })
    @ApiParam({
        name: 'integrationId',
        type: String,
        example: 'int_456',
    })
    getIntegrationRequiredParams(
        @Param('integrationId') integrationId: string,
        @Param('provider') provider: string,
    ) {
        return this.mcpService.getIntegrationRequiredParams(
            integrationId,
            provider,
        );
    }

    @Get(':provider/integrations/:integrationId/tools')
    @ApiOperation({
        summary: 'Get integration tools',
        description: 'Returns available tools for an integration.',
    })
    @ApiOkResponse({ type: [McpToolDto] })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'provider',
        type: String,
        example: 'composio',
    })
    @ApiParam({
        name: 'integrationId',
        type: String,
        example: 'int_456',
    })
    async getIntegrationTools(
        @Param('integrationId') integrationId: string,
        @Param('provider') provider: string,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.getIntegrationTools(
            integrationId,
            request.organizationId,
            provider,
        );
    }

    @Post(':provider/connect')
    @ApiOperation({
        summary: 'Initiate connection',
        description: 'Initiates a connection for a provider integration.',
    })
    @ApiCreatedResponse({ type: McpConnectionDto })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'provider',
        type: String,
        example: 'composio',
    })
    @ApiBody({ type: InitiateConnectionDto })
    initiateConnection(
        @Param('provider') provider: string,
        @Body() body: InitiateConnectionDto,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.initiateConnection(
            request.organizationId,
            provider,
            body,
        );
    }

    @Get('integration/custom')
    @ApiOperation({
        summary: 'List custom integrations',
        description: 'Lists custom integrations for the organization.',
    })
    @ApiOkResponse({ type: [McpIntegrationDto] })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiQuery({
        name: 'active',
        required: false,
        type: Boolean,
        example: true,
    })
    getCustomIntegrations(
        @Query('active') active: boolean,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.getCustomIntegrations(
            request.organizationId,
            active,
        );
    }

    @Get('integration/custom/:integrationId')
    @ApiOperation({
        summary: 'Get custom integration',
        description: 'Returns a custom integration by ID.',
    })
    @ApiOkResponse({ type: McpIntegrationDto })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'integrationId',
        type: String,
        example: 'int_456',
    })
    @ApiQuery({
        name: 'active',
        required: false,
        type: Boolean,
        example: true,
    })
    getProviderIntegration(
        @Param('integrationId') integrationId: string,
        @Query('active') active: boolean,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.getCustomIntegration(
            request.organizationId,
            integrationId,
            active,
        );
    }

    @Get('integration/custom/:integrationId/connection-config')
    @ApiOperation({
        summary: 'Get custom integration connection config',
        description:
            'Returns full connection config for a custom integration, including auth credentials. Internal use only.',
    })
    @ApiParam({
        name: 'integrationId',
        type: String,
        example: 'int_456',
    })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    getCustomIntegrationConnectionConfig(
        @Param('integrationId') integrationId: string,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.getCustomIntegrationConnectionConfig(
            request.organizationId,
            integrationId,
        );
    }

    @Post('integration/:provider')
    @ApiOperation({
        summary: 'Create integration',
        description: 'Creates a custom integration or a Kodus MCP integration.',
    })
    @ApiOkResponse({
        schema: {
            oneOf: [
                { $ref: getSchemaPath(McpIntegrationDto) },
                { $ref: getSchemaPath(McpKodusIntegrationResponseDto) },
            ],
        },
    })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'provider',
        type: String,
        example: 'custom',
    })
    @ApiBody({ type: CreateIntegrationDto })
    createIntegration(
        @Param('provider') provider: string,
        @Body() body: CreateIntegrationDto,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.createIntegration(
            request.organizationId,
            provider,
            body,
        );
    }

    @Put('integration/:provider/:integrationId')
    @ApiOperation({
        summary: 'Edit integration',
        description: 'Edits a custom integration.',
    })
    @ApiOkResponse({ type: McpIntegrationDto })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'provider',
        type: String,
        example: 'custom',
    })
    @ApiParam({
        name: 'integrationId',
        type: String,
        example: 'int_456',
    })
    @ApiBody({ type: CreateIntegrationDto })
    editIntegration(
        @Param('provider') provider: string,
        @Param('integrationId') integrationId: string,
        @Body() body: CreateIntegrationDto,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.editIntegration(
            request.organizationId,
            provider,
            integrationId,
            body,
        );
    }

    @Delete('integration/:provider/:integrationId')
    @ApiOperation({
        summary: 'Delete integration',
        description: 'Deletes a custom integration.',
    })
    @ApiOkResponse({ type: McpMessageResponseDto })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'provider',
        type: String,
        example: 'custom',
    })
    @ApiParam({
        name: 'integrationId',
        type: String,
        example: 'int_456',
    })
    deleteIntegration(
        @Param('provider') provider: string,
        @Param('integrationId') integrationId: string,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.deleteIntegration(
            request.organizationId,
            provider,
            integrationId,
        );
    }

    @Post('integration/:provider/oauth/finalize')
    @ApiOperation({
        summary: 'Finalize OAuth integration',
        description: 'Finalizes an OAuth integration with code/state.',
    })
    @ApiOkResponse({ type: McpMessageResponseDto })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'provider',
        type: String,
        example: 'custom',
    })
    @ApiBody({ type: FinishOAuthDto })
    finalizeOAuthIntegration(
        @Param('provider') provider: string,
        @Body() body: FinishOAuthDto,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.finalizeOAuthIntegration(
            request.organizationId,
            body,
            provider,
        );
    }

    @Post('integration/:provider/oauth/initialize')
    @ApiOperation({
        summary: 'Initialize OAuth integration',
        description: 'Starts OAuth flow for an integration.',
    })
    @ApiOkResponse({ type: McpOAuthInitResponseDto })
    @ApiBadRequestResponse({ type: ErrorResponseDto })
    @ApiUnauthorizedResponse({ type: ErrorResponseDto })
    @ApiForbiddenResponse({ type: ErrorResponseDto })
    @ApiInternalServerErrorResponse({ type: ErrorResponseDto })
    @ApiParam({
        name: 'provider',
        type: String,
        example: 'custom',
    })
    @ApiBody({ type: InitiateOAuthDto })
    initializeOAuthIntegration(
        @Param('provider') provider: string,
        @Body() body: InitiateOAuthDto,
        @Req() request: FastifyRequest,
    ) {
        return this.mcpService.initiateOAuthIntegration(
            request.organizationId,
            body,
            provider,
        );
    }
}
