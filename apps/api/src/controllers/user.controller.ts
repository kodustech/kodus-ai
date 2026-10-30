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
import { REQUEST } from '@nestjs/core';

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

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { AcceptUserInvitationUseCase } from '@libs/identity/application/use-cases/user/accept-user-invitation.use-case';
import { CheckUserWithEmailUserUseCase } from '@libs/identity/application/use-cases/user/check-user-email.use-case';
import { GetUserUseCase } from '@libs/identity/application/use-cases/user/get-user.use-case';
import { InviteDataUserUseCase } from '@libs/identity/application/use-cases/user/invite-data.use-case';
import { UpdateAnotherUserUseCase } from '@libs/identity/application/use-cases/user/update-another.use-case';
import { SaveMarketingSurveyUseCase } from '@libs/identity/application/use-cases/profile/save-marketing-survey.use-case';
import { AcceptUserInvitationDto } from '@libs/identity/dtos/accept-user-invitation.dto';
import { JoinOrganizationDto } from '@libs/identity/dtos/join-organization.dto';
import { UpdateAnotherUserDto } from '@libs/identity/dtos/update-another-user.dto';
import { JoinOrganizationUseCase } from '@libs/organization/application/use-cases/onboarding/join-organization.use-case';
import { MarketingSurveyDto } from '../dtos/marketingSurvey.dto';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import {
    ApiBooleanResponseDto,
    ApiObjectResponseDto,
} from '../dtos/api-response.dto';
import {
    UserInfoResponseDto,
    UserUpdateResponseDto,
} from '../dtos/user-response.dto';

@ApiTags('User')
@ApiStandardResponses()
@Controller('user')
export class UsersController {
    constructor(
        private readonly inviteDataUserUseCase: InviteDataUserUseCase,
        private readonly acceptUserInvitationUseCase: AcceptUserInvitationUseCase,
        private readonly checkUserWithEmailUserUseCase: CheckUserWithEmailUserUseCase,
        private readonly joinOrganizationUseCase: JoinOrganizationUseCase,
        private readonly updateAnotherUserUseCase: UpdateAnotherUserUseCase,
        private readonly getUserUseCase: GetUserUseCase,
        private readonly saveMarketingSurveyUseCase: SaveMarketingSurveyUseCase,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Get('/email')
    @Public()
    @ApiOperation({
        summary: 'Check user email',
        description: 'Return whether a user exists for the given email.',
    })
    @ApiQuery({ name: 'email', type: String, required: true })
    @ApiOkResponse({ type: ApiBooleanResponseDto })
    public async getEmail(
        @Query('email')
        email: string,
    ) {
        return await this.checkUserWithEmailUserUseCase.execute(email);
    }

    @Get('/invite')
    @Public()
    @ApiOperation({
        summary: 'Get invite data',
        description: 'Return invitation data for a user id.',
    })
    @ApiQuery({ name: 'userId', type: String, required: true })
    @ApiOkResponse({ type: ApiObjectResponseDto })
    public async getInviteDate(
        @Query('userId')
        userId: string,
    ) {
        return await this.inviteDataUserUseCase.execute(userId);
    }

    @Post('/invite/complete-invitation')
    @Public()
    @ApiOperation({
        summary: 'Complete invitation',
        description:
            'Activate a user invitation by setting password and profile.',
    })
    @ApiOkResponse({ type: ApiObjectResponseDto })
    public async completeInvitation(@Body() body: AcceptUserInvitationDto) {
        return await this.acceptUserInvitationUseCase.execute(body);
    }

    @Post('/join-organization')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.UserSettings,
        }),
    )
    @ApiOperation({
        summary: 'Join organization',
        description: 'Attach a user to an organization.',
    })
    @ApiCreatedResponse({ type: ApiObjectResponseDto })
    public async joinOrganization(@Body() body: JoinOrganizationDto) {
        return await this.joinOrganizationUseCase.execute(
            body,
            this.request.user,
        );
    }

    @Patch('/marketing-survey')
    @ApiBearerAuth('jwt')
    @ApiOperation({
        summary: 'Save marketing survey',
        description:
            'Persist referral source and primary goal for the authenticated user.',
    })
    @ApiOkResponse({ description: 'Survey saved successfully' })
    public async saveMarketingSurvey(
        @Body() body: MarketingSurveyDto,
    ): Promise<void> {
        const userId = this.request.user?.uuid;

        if (!userId) {
            throw new Error('User not found in request');
        }

        await this.saveMarketingSurveyUseCase.execute(userId, body);
    }

    @Patch('/:targetUserId')
    @ApiBearerAuth('jwt')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Update,
            resource: ResourceType.UserSettings,
        }),
    )
    @ApiOperation({
        summary: 'Update another user',
        description: 'Updates a user within the same organization.',
    })
    @ApiOkResponse({ type: UserUpdateResponseDto })
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

    @Get('/info')
    @ApiBearerAuth('jwt')
    @ApiOperation({
        summary: 'Get current user info',
        description: 'Return the authenticated user profile.',
    })
    @ApiOkResponse({ type: UserInfoResponseDto })
    public async show() {
        return await this.getUserUseCase.execute();
    }
}
