import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@/core/domain/organization/contracts/organization.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@/core/domain/user/contracts/user.service.contract';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { UpdateAnotherUserDto } from '@/core/infrastructure/http/dtos/update-another-user.dto';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class UpdateAnotherUserUseCase implements IUseCase {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(
        userId: string,
        targetUserId: string,
        data: UpdateAnotherUserDto,
        organizationId: string,
    ): Promise<IUser> {
        const { role, status } = data;

        try {
            const targetUser = await this.usersService.findOne({
                uuid: targetUserId,
            });
            if (!targetUser) {
                throw new Error('Target user not found');
            }

            const organization = await this.organizationService.findOne({
                uuid: organizationId,
            });
            if (!organization) {
                throw new Error('Organization not found');
            }

            const team = await this.teamService.findOne({
                organization: {
                    uuid: organization.uuid,
                },
            });
            if (!team) {
                throw new Error('Team not found');
            }

            const teamMember = await this.teamMembersService.findOne({
                organization: {
                    uuid: organization.uuid,
                },
                user: {
                    uuid: targetUser.uuid,
                },
            });
            if (!teamMember) {
                throw new Error(
                    'Target user is not a member of the organization team',
                );
            }

            const updatedUser = await this.usersService.update(
                { uuid: targetUserId },
                {
                    status,
                    role,
                },
            );

            if (!updatedUser) {
                throw new Error('Error updating user');
            }

            this.logger.log({
                message: 'User updated another user',
                context: UpdateAnotherUserUseCase.name,
                metadata: { userId, targetUserId, data },
            });

            return updatedUser.toObject();
        } catch (error) {
            this.logger.error({
                message: 'Error updating another user',
                error,
                metadata: { userId, targetUserId, data },
                context: UpdateAnotherUserUseCase.name,
            });
            throw error;
        }
    }
}
