import { createLogger } from '@kodus/flow';
import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { DeleteUserUseCase } from '@libs/identity/application/use-cases/user/delete.use-case';

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { TEAM_MEMBERS_SERVICE_TOKEN } from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';
import { TeamMemberEntity } from '@libs/organization/domain/teamMembers/entities/teamMember.entity';
import { TeamMemberService } from '@libs/organization/infrastructure/adapters/services/teamMembers.service';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { NotificationChannel } from '@libs/notifications/domain/enums/channel.enum';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

/**
 * Removes a team member. Only ever called from an authenticated HTTP
 * endpoint (`apps/api/src/controllers/teamMembers.controller.ts`) —
 * `REQUEST` is therefore safe to inject here. If a future caller needs
 * to remove members from a background job, the notification emit below
 * must be guarded behind `this.request?.user` and the caller should
 * provide the actor identity another way.
 */
@Injectable()
export class DeleteTeamMembersUseCase implements IUseCase {
    private readonly logger = createLogger(DeleteTeamMembersUseCase.name);

    constructor(
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: TeamMemberService,

        private readonly deleteUserUseCase: DeleteUserUseCase,
        private readonly notificationService: NotificationService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    public async execute(
        uuid: string,
        removeAll: boolean = false,
    ): Promise<string[] | void> {
        const memberToRemove = await this.teamMembersService.findOne({ uuid });

        // A user must not be able to remove their own account: it would
        // orphan the org and, for a single-team user, cascade into
        // deleting their own User entity via `deleteUserUseCase` below.
        if (
            memberToRemove?.user?.uuid &&
            memberToRemove.user.uuid === this.request.user?.uuid
        ) {
            throw new ForbiddenException('You cannot remove your own account');
        }

        const teamMembersRelated = await this.teamMembersService.findManyByUser(
            memberToRemove.user.uuid,
            true,
        );

        const teamMembers: TeamMemberEntity[] = removeAll
            ? teamMembersRelated
            : [memberToRemove];

        const countTeamMembers = await this.teamMembersService.countByUser(
            memberToRemove.user.uuid,
            true,
        );

        await this.teamMembersService.deleteMembers(teamMembers);

        // Notify the removed user (email) + remaining owners (in-app).
        // Best-effort: never fail the deletion over a notification.
        await this.notifyMemberRemoved(memberToRemove);

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

    /**
     * Fan out the org.member_removed notification. Removed user gets
     * the email channel (they're leaving and won't see in-app);
     * remaining org owners get the in-app channel.
     */
    private async notifyMemberRemoved(
        memberToRemove: TeamMemberEntity,
    ): Promise<void> {
        try {
            const removedUser = memberToRemove.user as
                | { uuid?: string; name?: string; email?: string }
                | undefined;
            const organization = memberToRemove.organization as
                | { uuid?: string; name?: string }
                | undefined;
            const organizationId =
                organization?.uuid ?? this.request.user?.organization?.uuid;

            if (!organizationId || !removedUser?.email) return;

            const removedBy =
                this.request.user?.email ?? this.request.user?.uuid ?? 'an admin';
            const organizationName =
                organization?.name ??
                this.request.user?.organization?.name ??
                'the organization';

            await this.notificationService.emit({
                event: NotificationEvent.ORG_MEMBER_REMOVED,
                payload: {
                    removedUser: {
                        name: removedUser.name,
                        email: removedUser.email,
                    },
                    removedBy,
                    removedAt: new Date().toISOString(),
                    organizationName,
                },
                organizationId,
                recipients: [
                    // Email-only to the removed user — they can't see in-app.
                    {
                        kind: 'email',
                        email: removedUser.email,
                        channels: [NotificationChannel.EMAIL],
                    },
                    // In-app-only to the remaining owners.
                    {
                        kind: 'role',
                        role: Role.OWNER,
                        channels: [NotificationChannel.IN_APP],
                    },
                ],
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to emit org.member_removed notification',
                error: error instanceof Error ? error : new Error(String(error)),
                context: DeleteTeamMembersUseCase.name,
            });
        }
    }
}
