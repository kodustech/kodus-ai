import { TEAM_MEMBERS_SERVICE_TOKEN } from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { TeamMemberEntity } from '@/core/domain/teamMembers/entities/teamMember.entity';
import { TeamMemberService } from '@/core/infrastructure/adapters/services/teamMembers.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { DeleteUserUseCase } from '../user/delete.use-case';

@Injectable()
export class DeleteTeamMembersUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: TeamMemberService,

        private readonly deleteUserUseCase: DeleteUserUseCase,
    ) {}

    public async execute(
        uuid: string,
        removeAll: boolean = false,
    ): Promise<string[] | void> {
        const memberToRemove = await this.teamMembersService.findOne({ uuid });

        const teamMembersRelated = await this.teamMembersService.findManyByUser(
            memberToRemove.user.uuid,
            true,
        );

        let teamMembers: TeamMemberEntity[] = [];

        if (removeAll) {
            teamMembers = teamMembersRelated;
        } else {
            teamMembers = [memberToRemove];
        }

        const countTeamMembers = await this.teamMembersService.countByUser(
            memberToRemove.user.uuid,
            true,
        );

        await this.teamMembersService.deleteMembers(teamMembers);

        if (countTeamMembers <= 1 || removeAll) {
            await this.deleteUserUseCase.execute(memberToRemove.user.uuid);
        } else {
            // If the user of the removed member is in more than one team, we return the other teams that he belongs to
            if (teamMembersRelated?.length > 0) {
                const teams = teamMembersRelated
                    .filter(
                        (member) =>
                            member?.team?.uuid !== memberToRemove?.team?.uuid,
                    )
                    .map((member) => member?.team?.name);

                return teams;
            }
        }

        return;
    }
}
