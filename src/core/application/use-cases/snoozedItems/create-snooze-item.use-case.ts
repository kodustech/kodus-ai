import {
    Inject,
    Injectable,
    InternalServerErrorException,
} from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { SnoozedItemsEntity } from '@/core/domain/snoozedItems/entities/snoozedItems.entity';
import { ModuleCategory } from '@/core/domain/snoozedItems/enums/module-category.enum';
import { SectionType } from '@/core/domain/snoozedItems/enums/section-type.enum';
import { REQUEST } from '@nestjs/core';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    ITeamMemberRepository,
    TEAM_MEMBERS_REPOSITORY_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.repository.contracts';
import {
    ISnoozedItemsService,
    SNOOZED_ITEMS_SERVICE_TOKEN,
} from '@/core/domain/snoozedItems/contracts/snoozedItems.service.contracts';
import { SnoozeTime } from '@/core/domain/snoozedItems/enums/snooze-time.enum';
import { NotificationLevel } from '@/core/domain/snoozedItems/enums/notification-level.enum';

@Injectable()
export class CreateSnoozeItemUseCase implements IUseCase {
    constructor(
        @Inject(SNOOZED_ITEMS_SERVICE_TOKEN)
        private readonly snoozedItemsService: ISnoozedItemsService,

        @Inject(TEAM_MEMBERS_REPOSITORY_TOKEN)
        private readonly teamMemberRepository: ITeamMemberRepository,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid; email };
        },

        private logger: PinoLoggerService,
    ) {}

    async execute(params: {
        category: ModuleCategory;
        sectionType: SectionType;
        notificationLevel?: NotificationLevel;
        snoozeTime: SnoozeTime;
        snoozeObject?: any;
        snoozeItemKey?: string;
        teamId?: string;
        organizationId?: string;
        slackUserId?: string;
        snoozedBy?: any;
    }): Promise<SnoozedItemsEntity> {
        try {
            const organizationId: string =
                params.organizationId || this.request.user.organization.uuid;

            if (!params.snoozedBy)
                params.snoozedBy = await this.identifyUser(params);
            return await this.snoozedItemsService.prepareDataToSave(
                params,
                organizationId,
            );
        } catch (error) {
            this.logger.error(error);
            throw new InternalServerErrorException(error);
        }
    }

    private async identifyUser(params: any): Promise<any> {
        let teamMember;

        let snoozedBy = {
            userName: 'Unknown user',
            userId: 'Unknown user',
        };

        if (params?.slackUserId) {
            const teamMembers =
                await this.teamMemberRepository.findMembersByCommunicationId(
                    params.slackUserId,
                );
            teamMember = teamMembers[0];
        } else {
            teamMember = await this.teamMemberRepository.findOne({
                user: { uuid: this.request.user.uuid },
            });
        }

        if (teamMember) {
            snoozedBy = {
                userName: teamMember?.name,
                userId: teamMember?.uuid,
            };
        } else {
            snoozedBy = {
                userName: this.request.user.email,
                userId: this.request.user.uuid,
            };
        }

        return snoozedBy;
    }
}
