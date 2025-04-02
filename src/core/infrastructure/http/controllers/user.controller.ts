import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { GetUserUseCase } from '@/core/application/use-cases/user/get-user.use-case';
import { InviteDataUserUseCase } from '@/core/application/use-cases/user/invite-data.use-case';

import { AcceptUserInvitationDto } from '../dtos/accept-user-invitation.dto';
import { AcceptUserInvitationUseCase } from '@/core/application/use-cases/user/accept-user-invitation.use-case';
import { CheckUserWithEmailUserUseCase } from '@/core/application/use-cases/user/check-user-email.use-case';

@Controller('user')
export class UsersController {
    constructor(
        private readonly getUserUseCase: GetUserUseCase,
        private readonly inviteDataUserUseCase: InviteDataUserUseCase,
        private readonly acceptUserInvitationUseCase: AcceptUserInvitationUseCase,
        private readonly checkUserWithEmailUserUseCase: CheckUserWithEmailUserUseCase,
    ) {}

    @Get('/email')
    public async getEmail(
        @Query('email')
        email: string,
    ) {
        return await this.checkUserWithEmailUserUseCase.execute(email);
    }

    @Get('/info')
    public async show() {
        return await this.getUserUseCase.execute();
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
}
