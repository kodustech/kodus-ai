import {
    Body,
    Controller,
    Get,
    Inject,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiBody,
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiExtraModels,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import {
    ApiBooleanResponseDto,
    ApiStringArrayResponseDto,
} from '../dtos/api-response.dto';
import {
    PermissionActionScopeDto,
    PermissionResourceDto,
    PermissionsResponseDto,
} from '../dtos/permissions-response.dto';

import { AssignReposUseCase } from '@libs/identity/application/use-cases/permissions/assign-repos.use-case';
import { CanAccessUseCase } from '@libs/identity/application/use-cases/permissions/can-access.use-case';
import { GetAssignedReposUseCase } from '@libs/identity/application/use-cases/permissions/get-assigned-repos.use-case';
import { GetPermissionsUseCase } from '@libs/identity/application/use-cases/permissions/get-permissions.use-case';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { createLogger } from '@libs/core/log/logger';

@ApiTags('Permissions')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@ApiExtraModels(PermissionResourceDto, PermissionActionScopeDto)
@Controller('permissions')
export class PermissionsController {
    private readonly logger = createLogger(PermissionsController.name);

    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: Partial<IUser>;
        },

        private readonly getPermissionsUseCase: GetPermissionsUseCase,
        private readonly canAccessUseCase: CanAccessUseCase,
        private readonly getAssignedReposUseCase: GetAssignedReposUseCase,
        private readonly assignReposUseCase: AssignReposUseCase,
    ) {}

    @Get()
    @ApiOperation({
        summary: 'List permissions',
        description: 'Return permissions grouped by resource and action.',
    })
    @ApiOkResponse({ type: PermissionsResponseDto })
    async getPermissions(): ReturnType<GetPermissionsUseCase['execute']> {
        const { user } = this.request;

        if (!user) {
            this.logger.warn({
                message: 'No user found in request',
                context: PermissionsController.name,
            });

            return {};
        }

        return this.getPermissionsUseCase.execute({ user });
    }

    @Get('can-access')
    @ApiQuery({ name: 'action', enum: Action, type: String, required: true })
    @ApiQuery({
        name: 'resource',
        enum: ResourceType,
        type: String,
        required: true,
    })
    @ApiOperation({
        summary: 'Check permission',
        description:
            'Return whether the authenticated user can perform an action on a resource.',
    })
    @ApiOkResponse({ type: ApiBooleanResponseDto })
    async can(
        @Query('action') action: Action,
        @Query('resource') resource: ResourceType,
    ): Promise<boolean> {
        const { user } = this.request;

        if (!user) {
            this.logger.warn({
                message: 'No user found in request',
                context: PermissionsController.name,
            });

            return false;
        }

        return this.canAccessUseCase.execute({ user, action, resource });
    }

    @Get('assigned-repos')
    @ApiOperation({
        summary: 'List assigned repositories',
        description: 'Return repository IDs assigned to a user.',
    })
    @ApiOkResponse({ type: ApiStringArrayResponseDto })
    async getAssignedRepos(
        @Query('userId') userId?: string,
    ): Promise<string[]> {
        return this.getAssignedReposUseCase.execute({ userId });
    }

    @Post('assign-repos')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.UserSettings,
        }),
    )
    @ApiOperation({
        summary: 'Assign repositories',
        description: 'Assign repository IDs to a user within a team.',
    })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                repositoryIds: { type: 'array', items: { type: 'string' } },
                userId: { type: 'string' },
                teamId: { type: 'string' },
            },
            required: ['repositoryIds', 'userId', 'teamId'],
            example: {
                repositoryIds: ['1135722979', '1135722980'],
                userId: 'user_123',
                teamId: 'c33ef663-70e7-4f43-9605-0bbef979b8e0',
            },
        },
    })
    @ApiCreatedResponse({ type: ApiStringArrayResponseDto })
    async assignRepos(
        @Body()
        body: {
            repositoryIds: string[];
            userId: string;
            teamId: string;
        },
    ) {
        return this.assignReposUseCase.execute({
            repoIds: body.repositoryIds,
            userId: body.userId,
            teamId: body.teamId,
        });
    }
}
