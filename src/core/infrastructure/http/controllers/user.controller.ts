import { InviteDataUserUseCase } from '@/core/application/use-cases/user/invite-data.use-case';
import {
    Body,
    Controller,
    Get,
    Inject,
    Param,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';

import { UserRequest } from '@/config/types/http/user-request.type';
import { AcceptUserInvitationUseCase } from '@/core/application/use-cases/user/accept-user-invitation.use-case';
import { CheckUserWithEmailUserUseCase } from '@/core/application/use-cases/user/check-user-email.use-case';
import { JoinOrganizationUseCase } from '@/core/application/use-cases/user/join-organization.use-case';
import { UpdateAnotherUserUseCase } from '@/core/application/use-cases/user/update-another.use-case';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { REQUEST } from '@nestjs/core';
import {
    CheckPolicies,
    PolicyGuard,
} from '../../adapters/services/permissions/policy.guard';
import { checkPermissions } from '../../adapters/services/permissions/policy.handlers';
import { AcceptUserInvitationDto } from '../dtos/accept-user-invitation.dto';
import { JoinOrganizationDto } from '../dtos/join-organization.dto';
import { UpdateAnotherUserDto } from '../dtos/update-another-user.dto';

@Controller('user')
export class UsersController {
    constructor(
        private readonly inviteDataUserUseCase: InviteDataUserUseCase,
        private readonly acceptUserInvitationUseCase: AcceptUserInvitationUseCase,
        private readonly checkUserWithEmailUserUseCase: CheckUserWithEmailUserUseCase,
        private readonly joinOrganizationUseCase: JoinOrganizationUseCase,
        private readonly updateAnotherUserUseCase: UpdateAnotherUserUseCase,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Get('/email')
    public async getEmail(
        @Query('email')
        email: string,
    ) {
        return await this.checkUserWithEmailUserUseCase.execute(email);
    }

    @Get('/invite')
    public async getInviteDate(
        @Query('userId')
        userId: string,
    ) {
        return await this.inviteDataUserUseCase.execute(userId);
    }

    @Post('/invite/complete-invitation')
    public async completeInvitation(@Body() body: AcceptUserInvitationDto) {
        return await this.acceptUserInvitationUseCase.execute(body);
    }

    @Post('/join-organization')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.UserSettings,
        }),
    )
    public async joinOrganization(@Body() body: JoinOrganizationDto) {
        return await this.joinOrganizationUseCase.execute(body);
    }

    @Patch('/:targetUserId')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.UserSettings,
        }),
    )
    public async updateAnother(
        @Body() body: UpdateAnotherUserDto,
        @Param('targetUserId') targetUserId: string,
    ): Promise<IUser> {
        if (!targetUserId) {
            throw new Error('targetUserId is required');
        }

        const userId = this.request.user?.uuid;
        const organizationId = this.request.user?.organization?.uuid;

        if (!userId) {
            throw new Error('User not found in request');
        }

        if (!organizationId) {
            throw new Error('Organization not found in request');
        }

        return await this.updateAnotherUserUseCase.execute(
            userId,
            targetUserId,
            body,
            organizationId,
        );
    }
}
