import { GetPermissionsUseCase } from '@/core/application/use-cases/permissions/get-permissions.use-case';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import {
    Body,
    Controller,
    Get,
    Inject,
    Post,
    Query,
    UseGuards,
    UseInterceptors,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { PinoLoggerService } from '../../adapters/services/logger/pino.service';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { CanAccessUseCase } from '@/core/application/use-cases/permissions/can-access.use-case';
import { CacheInterceptor, CacheTTL } from '@nestjs/cache-manager';
import { GetAssignedReposUseCase } from '@/core/application/use-cases/permissions/get-assigned-repos.use-case';
import {
    CheckPolicies,
    PolicyGuard,
} from '../../adapters/services/permissions/policy.guard';
import { subject } from '@casl/ability';
import { AssignReposUseCase } from '@/core/application/use-cases/permissions/assign-repos.use-case';
import { checkPermissions } from '../../adapters/services/permissions/policy.handlers';

@Controller('permissions')
export class PermissionsController {
    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: Partial<IUser>;
        },
        private readonly logger: PinoLoggerService,

        private readonly getPermissionsUseCase: GetPermissionsUseCase,
        private readonly canAccessUseCase: CanAccessUseCase,
        private readonly getAssignedReposUseCase: GetAssignedReposUseCase,
        private readonly assignReposUseCase: AssignReposUseCase,
    ) {}

    @Get()
    // @UseInterceptors(CacheInterceptor)
    // @CacheTTL(300000)
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
    // @UseInterceptors(CacheInterceptor)
    // @CacheTTL(300000)
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
    async getAssignedRepos(
        @Query('userId') userId?: string,
    ): Promise<string[]> {
        return this.getAssignedReposUseCase.execute({ userId });
    }

    @Post('assign-repos')
    @UseGuards(PolicyGuard)
    @CheckPolicies(checkPermissions({
        action: Action.Update,
        resource: ResourceType.UserSettings
    }))
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
