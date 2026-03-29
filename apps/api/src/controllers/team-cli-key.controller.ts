import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Param,
    Body,
    UseGuards,
    Inject,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkRole } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import {
    ITeamCliKeyService,
    TEAM_CLI_KEY_SERVICE_TOKEN,
} from '@libs/organization/domain/team-cli-key/contracts/team-cli-key.service.contract';
import {
    ITeamCliKeyConfig,
    TEAM_CLI_KEY_CAPABILITIES,
} from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditLogEvents } from '@libs/ee/codeReviewSettingsLog/events/audit-log.events';
import { ActionType } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    TeamCliKeyCreatedResponseDto,
    TeamCliKeyDeleteResponseDto,
    TeamCliKeyListResponseDto,
    TeamCliKeyUpdateResponseDto,
} from '../dtos/team-cli-key-response.dto';

/**
 * Controller for Team CLI Key management
 * Allows team managers to generate, list, and revoke CLI keys for their team
 */
@ApiTags('Team CLI Key')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('teams/:teamId/cli-keys')
@UseGuards(PolicyGuard)
export class TeamCliKeyController {
    constructor(
        @Inject(TEAM_CLI_KEY_SERVICE_TOKEN)
        private readonly teamCliKeyService: ITeamCliKeyService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    /**
     * Generate a new CLI key for the team
     */
    @Post()
    @CheckPolicies(
        checkRole({
            role: Role.OWNER,
        }),
    )
    @ApiOperation({
        summary: 'Create team CLI key',
        description: 'Generate a new CLI key for the specified team.',
    })
    @ApiCreatedResponse({ type: TeamCliKeyCreatedResponseDto })
    async generateKey(
        @Param('teamId') teamId: string,
        @Body() body: { name: string; config?: ITeamCliKeyConfig },
    ) {
        const userId = this.request.user?.uuid;

        if (!userId) {
            throw new HttpException(
                'User not found in request',
                HttpStatus.UNAUTHORIZED,
            );
        }

        if (!body.name || body.name.trim().length === 0) {
            throw new HttpException(
                'Key name is required',
                HttpStatus.BAD_REQUEST,
            );
        }

        const key = await this.teamCliKeyService.generateKey(
            teamId,
            body.name,
            userId,
            body.config,
        );

        this.eventEmitter.emit(AuditLogEvents.CLI_KEY, {
            organizationAndTeamData: {
                organizationId: this.request.user?.organization?.uuid,
                teamId,
            },
            userInfo: {
                userId: this.request.user?.uuid,
                userEmail: this.request.user?.email,
            },
            actionType: ActionType.CREATE,
            keyName: body.name,
        });

        return {
            key,
            message: 'Save this key securely. It will not be shown again.',
        };
    }

    /**
     * List all CLI keys for the team
     */
    @Get()
    @CheckPolicies(
        checkRole({
            role: Role.OWNER,
        }),
    )
    @ApiOperation({
        summary: 'List team CLI keys',
        description: 'Return all CLI keys for the specified team.',
    })
    @ApiOkResponse({ type: TeamCliKeyListResponseDto })
    async listKeys(@Param('teamId') teamId: string) {
        const keys = await this.teamCliKeyService.findByTeamId(teamId);

        // Don't return the actual key hash, only metadata
        return (keys ?? []).map((key) => ({
            uuid: key.uuid,
            name: key.name,
            active: key.active,
            config: this.formatConfig(key.config),
            lastUsedAt: key.lastUsedAt,
            createdAt: key.createdAt,
            createdBy: key.createdBy
                ? {
                      uuid: key.createdBy.uuid,
                  }
                : null,
        }));
    }

    @Patch(':keyId/config')
    @CheckPolicies(
        checkRole({
            role: Role.OWNER,
        }),
    )
    @ApiOperation({
        summary: 'Update team CLI key config',
        description:
            'Update the config object for a CLI key belonging to the specified team.',
    })
    @ApiOkResponse({ type: TeamCliKeyUpdateResponseDto })
    async updateKeyConfig(
        @Param('teamId') teamId: string,
        @Param('keyId') keyId: string,
        @Body() body: { config?: ITeamCliKeyConfig },
    ) {
        const key = await this.teamCliKeyService.findById(keyId);

        if (!key || key.team?.uuid !== teamId) {
            throw new HttpException('CLI key not found', HttpStatus.NOT_FOUND);
        }

        if (!body.config) {
            throw new HttpException(
                'CLI key config is required',
                HttpStatus.BAD_REQUEST,
            );
        }

        const updatedKey = await this.teamCliKeyService.update(
            { uuid: keyId },
            { config: body.config },
        );

        if (!updatedKey) {
            throw new HttpException(
                'CLI key could not be updated',
                HttpStatus.BAD_REQUEST,
            );
        }

        return {
            uuid: updatedKey.uuid,
            name: updatedKey.name,
            active: updatedKey.active,
            config: this.formatConfig(updatedKey.config),
            lastUsedAt: updatedKey.lastUsedAt,
            createdAt: updatedKey.createdAt,
            createdBy: updatedKey.createdBy
                ? {
                      uuid: updatedKey.createdBy.uuid,
                  }
                : null,
        };
    }

    /**
     * Revoke a CLI key
     */
    @Delete(':keyId')
    @CheckPolicies(
        checkRole({
            role: Role.OWNER,
        }),
    )
    @ApiOperation({
        summary: 'Revoke team CLI key',
        description: 'Revoke a CLI key by id for the specified team.',
    })
    @ApiOkResponse({ type: TeamCliKeyDeleteResponseDto })
    async revokeKey(
        @Param('teamId') teamId: string,
        @Param('keyId') keyId: string,
    ) {
        // Verify key belongs to this team
        const key = await this.teamCliKeyService.findById(keyId);

        if (!key || key.team?.uuid !== teamId) {
            throw new HttpException('CLI key not found', HttpStatus.NOT_FOUND);
        }

        await this.teamCliKeyService.revokeKey(keyId);

        this.eventEmitter.emit(AuditLogEvents.CLI_KEY, {
            organizationAndTeamData: {
                organizationId: this.request.user?.organization?.uuid,
                teamId,
            },
            userInfo: {
                userId: this.request.user?.uuid,
                userEmail: this.request.user?.email,
            },
            actionType: ActionType.DELETE,
            keyName: key.name,
        });

        return {
            message: 'CLI key revoked successfully',
        };
    }

    private formatConfig(config?: ITeamCliKeyConfig) {
        const legacyConfig = config as
            | (ITeamCliKeyConfig & {
                  permissions?: {
                      configureRepositories?: boolean;
                  };
              })
            | undefined;

        const capabilities = new Set(config?.capabilities ?? []);

        if (legacyConfig?.permissions?.configureRepositories) {
            capabilities.add(TEAM_CLI_KEY_CAPABILITIES.CONFIG_REPO_MANAGE);
        }

        return {
            capabilities: Array.from(capabilities),
        };
    }
}
